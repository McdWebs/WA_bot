import { Router, Request, Response } from "express";
import { config } from "../config";
import mongoService from "../services/mongo";
import { getTwilioUsage } from "../services/twilioUsage";
import {
  getMessageStats,
  getMessageCountByPhone,
} from "../services/messageLog";
import { getTwilioUsageForRange } from "../services/twilioUsage";

const router = Router();

function getApiKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const key = req.headers["x-api-key"];
  if (typeof key === "string") return key.trim();
  return null;
}

function requireDashboardAuth(req: Request, res: Response, next: () => void): void {
  const apiKey = config.dashboard.apiKey;
  if (!apiKey) {
    res.status(503).json({ error: "Dashboard API is not configured (DASHBOARD_API_KEY missing)" });
    return;
  }
  const provided = getApiKey(req);
  if (!provided || provided !== apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use(requireDashboardAuth);

/** GET /api/dashboard/stats - Overview stats (includes Mongo stats + Twilio usage when available) */
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const [stats, usage] = await Promise.all([
      mongoService.getDashboardStats(),
      getTwilioUsage().catch(() => null),
    ]);
    const body: Record<string, unknown> = { ...stats };
    if (usage) {
      body.messagesToday = usage.today.count;
      body.messagesThisMonth = usage.thisMonth.count;
      body.costToday = usage.today.price;
      body.costThisMonth = usage.thisMonth.price;
      body.usageCached = usage.cached;
    }
    res.json(body);
  } catch {
    // MongoDB unreachable (e.g. network, Atlas IP whitelist) – return empty stats so dashboard still loads
    res.status(200).json({
      usersByStatus: {},
      usersTotal: 0,
      remindersByType: {},
      remindersTotal: 0,
      remindersEnabled: 0,
      signupsOverTime: [],
      databaseUnavailable: true,
    });
  }
});

/** GET /api/dashboard/users - List users (paginated, optional status, search, hasReminders) */
router.get("/users", async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const hasReminders =
      req.query.hasReminders === "true" || req.query.hasReminders === "1";
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);
    const skip = parseInt(String(req.query.skip || "0"), 10) || 0;

    const [users, total] = await Promise.all([
      mongoService.getAllUsers({ status, search, hasReminders, limit, skip }),
      mongoService.getUsersCount({ status, search, hasReminders }),
    ]);

    res.json({ users, total });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/** GET /api/dashboard/users/:id - User detail + reminders + message count */
router.get("/users/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const user = await mongoService.getUserById(id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const [reminders, messageCount] = await Promise.all([
      mongoService.getReminderSettings(user.id!),
      getMessageCountByPhone(user.phone_number),
    ]);
    res.json({ user, reminders, messageCount });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

/** GET /api/dashboard/reminders - List reminders with user (paginated, filters) */
router.get("/reminders", async (req: Request, res: Response) => {
  try {
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const enabled =
      typeof req.query.enabled === "string"
        ? req.query.enabled === "true"
          ? true
          : req.query.enabled === "false"
            ? false
            : undefined
        : undefined;
    const reminderType =
      typeof req.query.reminderType === "string" ? req.query.reminderType : undefined;
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);
    const skip = parseInt(String(req.query.skip || "0"), 10) || 0;

    const [reminders, total] = await Promise.all([
      mongoService.getAllReminderSettings({
        userId,
        enabled,
        reminderType,
        limit,
        skip,
      }),
      mongoService.getRemindersCount({ userId, enabled, reminderType }),
    ]);

    res.json({ reminders, total });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reminders" });
  }
});

/** GET /api/dashboard/reminders/:id - Single reminder + user */
router.get("/reminders/:id", async (req: Request, res: Response) => {
  try {
    const reminder = await mongoService.getReminderById(req.params.id);
    if (!reminder) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    res.json(reminder);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reminder" });
  }
});

/** PATCH /api/dashboard/reminders/:id - Update reminder (enabled, time_offset_minutes, test_time) */
router.patch("/reminders/:id", async (req: Request, res: Response) => {
  try {
    const reminderId = req.params.id;
    const existing = await mongoService.getReminderById(reminderId);
    if (!existing) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const updates: { enabled?: boolean; time_offset_minutes?: number; test_time?: string } = {};
    if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
    if (typeof body.time_offset_minutes === "number") updates.time_offset_minutes = body.time_offset_minutes;
    if (typeof body.test_time === "string" || body.test_time === null) updates.test_time = body.test_time ?? undefined;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }
    const updated = await mongoService.updateReminderSettingById(reminderId, updates);
    if (!updated) {
      res.status(500).json({ error: "Failed to update reminder" });
      return;
    }
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update reminder" });
  }
});

/** GET /api/dashboard/usage - Twilio usage/cost. Optional startDate/endDate (YYYY-MM-DD) for a range. */
router.get("/usage", async (req: Request, res: Response) => {
  try {
    const startDate =
      typeof req.query.startDate === "string" ? req.query.startDate : undefined;
    const endDate =
      typeof req.query.endDate === "string" ? req.query.endDate : undefined;
    if (startDate && endDate) {
      const range = await getTwilioUsageForRange(startDate, endDate);
      res.json(range);
      return;
    }
    const usage = await getTwilioUsage();
    res.json({
      today: usage.today,
      thisMonth: usage.thisMonth,
      cached: usage.cached,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch usage" });
  }
});

/** GET /api/dashboard/messages - Message stats (from message_log) */
router.get("/messages", async (req: Request, res: Response) => {
  try {
    const startDate =
      typeof req.query.startDate === "string" ? req.query.startDate : undefined;
    const endDate =
      typeof req.query.endDate === "string" ? req.query.endDate : undefined;
    const phoneNumber =
      typeof req.query.phoneNumber === "string" ? req.query.phoneNumber : undefined;
    const stats = await getMessageStats({ startDate, endDate, phoneNumber });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

export default router;
