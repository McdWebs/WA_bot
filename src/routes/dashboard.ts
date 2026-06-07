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

interface BroadcastBatchProgress {
  name: string;
  total: number;
  skipped: number;
  submitted: number;
  failed: number;
  remaining: number;
  delivered: number;
  sent: number;
  undelivered: number;
}

interface BroadcastProgress {
  /** idle = never run this process; running = in progress; completed/error = finished */
  status: "idle" | "running" | "completed" | "error";
  /** finer-grained step shown in the UI */
  phase: "idle" | "sending" | "polling" | "done" | "error";
  campaign: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number; // all users in scope
  skipped: number; // already delivered in a previous run
  toSend: number; // how many this run will attempt (after dedupe + cap)
  submitted: number;
  failed: number;
  remaining: number; // pending users NOT attempted this run (cap overflow) -> need another run
  capReached: boolean;
  maxPerRun: number;
  delivered: number;
  sent: number;
  undelivered: number;
  deliveryPending: boolean;
  batches: BroadcastBatchProgress[];
  error: string | null;
}

function freshBroadcastProgress(): BroadcastProgress {
  return {
    status: "idle",
    phase: "idle",
    campaign: config.broadcast.campaign,
    startedAt: null,
    finishedAt: null,
    total: 0,
    skipped: 0,
    toSend: 0,
    submitted: 0,
    failed: 0,
    remaining: 0,
    capReached: false,
    maxPerRun: config.broadcast.maxPerRun,
    delivered: 0,
    sent: 0,
    undelivered: 0,
    deliveryPending: false,
    batches: [],
    error: null,
  };
}

// In-memory progress for the current/last broadcast run (single Render instance).
// Dedupe lives in Mongo, so even if this is lost on restart the next run resumes safely.
let broadcastProgress: BroadcastProgress = freshBroadcastProgress();

/**
 * Runs the full broadcast in the background, updating `broadcastProgress` as it goes
 * so GET /broadcast/status can report live progress. Sends in two batches
 * (users with reminders first, then everyone else), skipping already-delivered users
 * and honoring the per-run cap (BROADCAST_MAX_PER_RUN).
 */
async function runBroadcastJob(): Promise<void> {
  const { campaign, delayMs, maxPerRun } = config.broadcast;
  try {
    await ensureBroadcastIndexes();

    const { withReminders, withoutReminders } =
      await mongoService.getUsersForBroadcast();
    const alreadySent = await getAlreadySentPhones(campaign);

    const batchDefs = [
      { name: "with_reminders", users: withReminders },
      { name: "without_reminders", users: withoutReminders },
    ];
    const pendingByBatch = batchDefs.map((b) =>
      b.users.filter((u) => !alreadySent.has(u.phone_number))
    );

    const totalUsers = withReminders.length + withoutReminders.length;
    const pendingTotal = pendingByBatch.reduce((n, p) => n + p.length, 0);
    const toSend = maxPerRun > 0 ? Math.min(pendingTotal, maxPerRun) : pendingTotal;

    broadcastProgress = {
      ...freshBroadcastProgress(),
      status: "running",
      phase: "sending",
      campaign,
      startedAt: new Date().toISOString(),
      total: totalUsers,
      skipped: totalUsers - pendingTotal,
      toSend,
      remaining: pendingTotal,
      maxPerRun,
      batches: batchDefs.map((b, i) => ({
        name: b.name,
        total: b.users.length,
        skipped: b.users.length - pendingByBatch[i].length,
        submitted: 0,
        failed: 0,
        remaining: pendingByBatch[i].length,
        delivered: 0,
        sent: 0,
        undelivered: 0,
      })),
    };

    logger.info(
      `Starting broadcast campaign="${campaign}" total=${totalUsers} ` +
        `pending=${pendingTotal} skipped=${broadcastProgress.skipped} ` +
        `toSend=${toSend} maxPerRun=${maxPerRun || "∞"}`
    );

    const allSids: string[] = [];
    const batchSids: string[][] = batchDefs.map(() => []);
    let attempted = 0;
    let capReached = false;

    for (let bi = 0; bi < batchDefs.length; bi++) {
      const pending = pendingByBatch[bi];
      const bp = broadcastProgress.batches[bi];
      let processed = 0;

      for (let i = 0; i < pending.length; i++) {
        if (maxPerRun > 0 && attempted >= maxPerRun) {
          capReached = true;
          break;
        }

        const user = pending[i];
        processed++;
        attempted++;
        try {
          const sid = await sendBroadcastTemplate(user.phone_number);
          batchSids[bi].push(sid);
          allSids.push(sid);
          bp.submitted++;
          broadcastProgress.submitted++;
          await recordBroadcastSend(campaign, user.phone_number, batchDefs[bi].name, sid, "queued");
        } catch (error) {
          bp.failed++;
          broadcastProgress.failed++;
          await recordBroadcastSend(campaign, user.phone_number, batchDefs[bi].name, undefined, "failed");
          logger.error(`Broadcast failed for ${user.phone_number}:`, error);
        }

        bp.remaining = pending.length - processed;
        broadcastProgress.remaining = pendingTotal - attempted;

        const moreInBatch = i < pending.length - 1;
        if (moreInBatch && delayMs > 0) {
          await sleep(delayMs);
        }
      }

      if (capReached) {
        broadcastProgress.capReached = true;
        logger.info(`Broadcast per-run cap (${maxPerRun}) reached; stopping early`);
        break;
      }
    }

    broadcastProgress.phase = "polling";
    logger.info(
      `Broadcast submits done: submitted=${broadcastProgress.submitted}, ` +
        `failed=${broadcastProgress.failed}, polling delivery for ${allSids.length} message(s)`
    );

    const { statuses, deliveryPending } = await pollBroadcastDeliveryStatuses(
      campaign,
      allSids
    );

    for (let bi = 0; bi < batchDefs.length; bi++) {
      const counts = countDelivery(batchSids[bi], statuses);
      const bp = broadcastProgress.batches[bi];
      bp.delivered = counts.delivered;
      bp.sent = counts.sent;
      bp.undelivered = counts.undelivered;
    }

    const totals = countDelivery(allSids, statuses);
    broadcastProgress.delivered = totals.delivered;
    broadcastProgress.sent = totals.sent;
    broadcastProgress.undelivered = totals.undelivered;
    broadcastProgress.deliveryPending = deliveryPending;
    broadcastProgress.status = "completed";
    broadcastProgress.phase = "done";
    broadcastProgress.finishedAt = new Date().toISOString();

    logger.info(
      `Broadcast finished: submitted=${broadcastProgress.submitted}, failed=${broadcastProgress.failed}, ` +
        `delivered=${totals.delivered}, undelivered=${totals.undelivered}, ` +
        `remaining=${broadcastProgress.remaining}, capReached=${broadcastProgress.capReached}`
    );
  } catch (error) {
    broadcastProgress.status = "error";
    broadcastProgress.phase = "error";
    broadcastProgress.error = (error as Error)?.message || String(error);
    broadcastProgress.finishedAt = new Date().toISOString();
    logger.error("Broadcast job error:", error);
  }
}

/**
 * POST /api/dashboard/broadcast - Start the broadcast in the BACKGROUND and return
 * immediately (the send + delivery polling can take many minutes, which would
 * otherwise time out the HTTP request behind a proxy). Poll GET /broadcast/status
 * for live progress. If a run is already in progress, returns the current progress.
 */
router.post("/broadcast", (_req: Request, res: Response) => {
  if (broadcastProgress.status === "running") {
    res.status(202).json({ started: false, alreadyRunning: true, progress: broadcastProgress });
    return;
  }

  // Seed a "running" snapshot synchronously so an immediate status poll sees it.
  broadcastProgress = {
    ...freshBroadcastProgress(),
    status: "running",
    phase: "sending",
    startedAt: new Date().toISOString(),
  };

  setImmediate(() => {
    runBroadcastJob().catch((error) => {
      broadcastProgress.status = "error";
      broadcastProgress.phase = "error";
      broadcastProgress.error = (error as Error)?.message || String(error);
      logger.error("Unhandled broadcast job error:", error);
    });
  });

  res.status(202).json({ started: true, progress: broadcastProgress });
});

/** GET /api/dashboard/broadcast/status - Live progress of the current/last broadcast run. */
router.get("/broadcast/status", (_req: Request, res: Response) => {
  res.json(broadcastProgress);
});

export default router;
