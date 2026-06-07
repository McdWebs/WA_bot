import { Router, Request, Response } from "express";
import { config } from "../config";
import mongoService from "../services/mongo";
import twilioService from "../services/twilio";
import logger from "../utils/logger";
import { getTwilioUsage } from "../services/twilioUsage";
import {
  getMessageStats,
  getMessageCountByPhone,
  updateMessageLogStatus,
} from "../services/messageLog";
import { getTwilioUsageForRange } from "../services/twilioUsage";
import {
  ensureBroadcastIndexes,
  getAlreadySentPhones,
  recordBroadcastSend,
  updateBroadcastStatus,
} from "../services/broadcastService";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTwilioRateLimitError(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 63018 || code === "63018";
}

async function sendBroadcastTemplate(phoneNumber: string): Promise<string> {
  const { rateLimitRetries, rateLimitBackoffMs } = config.broadcast;
  let backoffMs = rateLimitBackoffMs;

  for (let attempt = 0; attempt <= rateLimitRetries; attempt++) {
    try {
      const { sid } = await twilioService.sendTemplateMessage(phoneNumber, "broadcast");
      return sid;
    } catch (error) {
      if (!isTwilioRateLimitError(error) || attempt === rateLimitRetries) {
        throw error;
      }
      logger.warn(
        `Broadcast rate limit (63018) for ${phoneNumber}, retry ${attempt + 1}/${rateLimitRetries} in ${backoffMs}ms`
      );
      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }

  throw new Error("Broadcast send failed after retries");
}

type DeliveryBucket = "delivered" | "sent" | "undelivered";

function categorizeDeliveryStatus(status: string): DeliveryBucket {
  const normalized = status.toLowerCase();
  if (normalized === "delivered" || normalized === "read") {
    return "delivered";
  }
  if (normalized === "failed" || normalized === "undelivered" || normalized === "canceled") {
    return "undelivered";
  }
  return "sent";
}

function isTerminalDeliveryStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return ["delivered", "read", "failed", "undelivered", "canceled"].includes(normalized);
}

/**
 * Polls Twilio for the final delivery status of each sent message and returns a
 * sid -> status map. Also mirrors each status into the message log and the
 * broadcast recipient tracker (so dedupe/resume sees undelivered ones as retryable).
 */
async function pollBroadcastDeliveryStatuses(
  campaign: string,
  messageSids: string[]
): Promise<{ statuses: Map<string, string>; deliveryPending: boolean }> {
  const statuses = new Map<string, string>();
  if (messageSids.length === 0) {
    return { statuses, deliveryPending: false };
  }

  const { deliveryPollIntervalMs, deliveryPollMaxWaitMs } = config.broadcast;
  const started = Date.now();
  let latestStatuses: string[] = [];

  while (Date.now() - started < deliveryPollMaxWaitMs) {
    latestStatuses = await Promise.all(
      messageSids.map((sid) => twilioService.fetchMessageStatus(sid))
    );

    for (let i = 0; i < messageSids.length; i++) {
      statuses.set(messageSids[i], latestStatuses[i]);
      updateMessageLogStatus(messageSids[i], latestStatuses[i]).catch(() => {});
      updateBroadcastStatus(campaign, messageSids[i], latestStatuses[i]).catch(() => {});
    }

    if (latestStatuses.every(isTerminalDeliveryStatus)) {
      break;
    }

    await sleep(deliveryPollIntervalMs);
  }

  return {
    statuses,
    deliveryPending: !latestStatuses.every(isTerminalDeliveryStatus),
  };
}

/** Tally delivery buckets for a specific list of sids using the polled status map. */
function countDelivery(
  sids: string[],
  statuses: Map<string, string>
): { delivered: number; sent: number; undelivered: number } {
  const counts = { delivered: 0, sent: 0, undelivered: 0 };
  for (const sid of sids) {
    const status = statuses.get(sid);
    // No status yet (still in flight) counts as "sent / in transit".
    counts[status ? categorizeDeliveryStatus(status) : "sent"]++;
  }
  return counts;
}

interface BroadcastBatchDef {
  name: string;
  users: { phone_number: string }[];
}

interface BroadcastBatchResult {
  name: string;
  total: number;
  skipped: number;
  submitted: number;
  failed: number;
  remaining: number;
  sids: string[];
}

/**
 * POST /api/dashboard/broadcast - Send the campaign template to users in two batches:
 *   1) users with at least one reminder, then 2) everyone else.
 * Already-delivered users are skipped (dedupe/resume), and an optional per-run cap
 * (BROADCAST_MAX_PER_RUN) stops once the WhatsApp 24h tier limit is reached so the
 * overflow is left for the next run instead of going undelivered.
 */
router.post("/broadcast", async (_req: Request, res: Response) => {
  try {
    await ensureBroadcastIndexes();

    const { campaign, delayMs, maxPerRun } = config.broadcast;
    const { withReminders, withoutReminders } =
      await mongoService.getUsersForBroadcast();
    const alreadySent = await getAlreadySentPhones(campaign);

    const batches: BroadcastBatchDef[] = [
      { name: "with_reminders", users: withReminders },
      { name: "without_reminders", users: withoutReminders },
    ];

    const totalUsers = withReminders.length + withoutReminders.length;
    logger.info(
      `Starting broadcast campaign="${campaign}" total=${totalUsers} ` +
        `withReminders=${withReminders.length} withoutReminders=${withoutReminders.length} ` +
        `alreadySent=${alreadySent.size} maxPerRun=${maxPerRun || "∞"}`
    );

    const batchResults: BroadcastBatchResult[] = [];
    const allSids: string[] = [];
    let submittedThisRun = 0;
    let capReached = false;

    for (const batch of batches) {
      const pending = batch.users.filter((u) => !alreadySent.has(u.phone_number));
      const skipped = batch.users.length - pending.length;
      let submitted = 0;
      let failed = 0;
      let processed = 0;
      const sids: string[] = [];

      logger.info(
        `Broadcast batch="${batch.name}" total=${batch.users.length} ` +
          `pending=${pending.length} skipped=${skipped}`
      );

      for (let i = 0; i < pending.length; i++) {
        if (maxPerRun > 0 && submittedThisRun >= maxPerRun) {
          capReached = true;
          break;
        }

        const user = pending[i];
        processed++;
        try {
          const sid = await sendBroadcastTemplate(user.phone_number);
          sids.push(sid);
          allSids.push(sid);
          submitted++;
          submittedThisRun++;
          await recordBroadcastSend(campaign, user.phone_number, batch.name, sid, "queued");
          if (submittedThisRun % 25 === 0) {
            logger.info(`Broadcast progress ${submittedThisRun} submitted this run`);
          }
        } catch (error) {
          failed++;
          await recordBroadcastSend(campaign, user.phone_number, batch.name, undefined, "failed");
          logger.error(`Broadcast failed for ${user.phone_number}:`, error);
        }

        const moreInBatch = i < pending.length - 1;
        if (moreInBatch && delayMs > 0) {
          await sleep(delayMs);
        }
      }

      batchResults.push({
        name: batch.name,
        total: batch.users.length,
        skipped,
        submitted,
        failed,
        remaining: pending.length - processed,
        sids,
      });

      if (capReached) {
        logger.info(`Broadcast per-run cap (${maxPerRun}) reached; stopping early`);
        break;
      }
    }

    // Account for batches not started at all because the cap was hit earlier.
    while (batchResults.length < batches.length) {
      const batch = batches[batchResults.length];
      const pending = batch.users.filter((u) => !alreadySent.has(u.phone_number));
      batchResults.push({
        name: batch.name,
        total: batch.users.length,
        skipped: batch.users.length - pending.length,
        submitted: 0,
        failed: 0,
        remaining: pending.length,
        sids: [],
      });
    }

    logger.info(
      `Broadcast submits finished: submitted=${submittedThisRun}, polling delivery for ${allSids.length} message(s)`
    );

    const { statuses, deliveryPending } = await pollBroadcastDeliveryStatuses(
      campaign,
      allSids
    );

    const totals = countDelivery(allSids, statuses);
    const totalSkipped = batchResults.reduce((n, b) => n + b.skipped, 0);
    const totalFailed = batchResults.reduce((n, b) => n + b.failed, 0);
    const totalRemaining = batchResults.reduce((n, b) => n + b.remaining, 0);

    logger.info(
      `Broadcast finished: submitted=${submittedThisRun}, failed=${totalFailed}, ` +
        `delivered=${totals.delivered}, sent=${totals.sent}, undelivered=${totals.undelivered}, ` +
        `remaining=${totalRemaining}, capReached=${capReached}`
    );

    res.json({
      campaign,
      total: totalUsers,
      skipped: totalSkipped,
      submitted: submittedThisRun,
      failed: totalFailed,
      remaining: totalRemaining,
      capReached,
      maxPerRun,
      delivered: totals.delivered,
      sent: totals.sent,
      undelivered: totals.undelivered,
      deliveryPending,
      batches: batchResults.map((b) => ({
        name: b.name,
        total: b.total,
        skipped: b.skipped,
        submitted: b.submitted,
        failed: b.failed,
        remaining: b.remaining,
        ...countDelivery(b.sids, statuses),
      })),
    });
  } catch (error) {
    logger.error("Broadcast route error:", error);
    res.status(500).json({ error: "Failed to send broadcast" });
  }
});

export default router;
