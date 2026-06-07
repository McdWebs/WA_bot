import { Collection } from "mongodb";
import { getDb } from "./mongo";
import logger from "../utils/logger";

/**
 * Tracks who already received a given broadcast campaign so re-running the
 * broadcast skips them (dedupe) and resumes where it left off. A recipient is
 * only "done" while its status is a healthy Twilio status; undelivered/failed
 * recipients are retried on the next run.
 */
export interface BroadcastRecipient {
  campaign: string;
  phone_number: string;
  batch: string;
  sid?: string;
  status: string;
  sent_at: string;
  updated_at: string;
}

// Twilio statuses that mean "this user already got it (or it's on the way)".
// Anything outside this set (undelivered/failed/canceled) is eligible for retry.
const HEALTHY_STATUSES = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "receiving",
  "received",
];

function getCollection(): Promise<Collection<BroadcastRecipient>> {
  return getDb().then((d) => d.collection<BroadcastRecipient>("broadcast_recipients"));
}

export async function ensureBroadcastIndexes(): Promise<void> {
  try {
    const col = await getCollection();
    await col.createIndex({ campaign: 1, phone_number: 1 }, { unique: true });
    await col.createIndex({ campaign: 1, sid: 1 });
  } catch (error) {
    logger.warn("Broadcast index ensure failed (continuing):", error);
  }
}

/**
 * Phone numbers that should NOT be sent the broadcast again because they already
 * received it successfully. Unions two sources:
 *   1) broadcast_recipients for this campaign (the new per-campaign tracker), and
 *   2) message_log entries with template_key "broadcast" and a healthy status —
 *      this covers sends made by earlier broadcast runs (before per-campaign
 *      tracking existed), so the very first run won't re-message people who
 *      already got it.
 * Undelivered/failed recipients are intentionally excluded so they get retried.
 *
 * Note: source (2) is keyed on the broadcast template, not on `campaign`, so if you
 * deliberately start a fresh campaign (BROADCAST_CAMPAIGN) reusing the same template,
 * prior recipients will still be skipped. Use a new template for a true re-send.
 */
export async function getAlreadySentPhones(campaign: string): Promise<Set<string>> {
  const db = await getDb();
  const recipients = db.collection("broadcast_recipients");
  const messageLog = db.collection("message_log");

  const [recipientDocs, logDocs] = await Promise.all([
    recipients
      .find({ campaign, status: { $in: HEALTHY_STATUSES } })
      .project({ phone_number: 1 })
      .toArray(),
    messageLog
      .find({ template_key: "broadcast", status: { $in: HEALTHY_STATUSES } })
      .project({ phone_number: 1 })
      .toArray(),
  ]);

  const phones = new Set<string>();
  for (const d of recipientDocs as any[]) phones.add(d.phone_number);
  for (const d of logDocs as any[]) phones.add(d.phone_number);
  return phones;
}

/** Record (or update) a recipient after a submit attempt. */
export async function recordBroadcastSend(
  campaign: string,
  phoneNumber: string,
  batch: string,
  sid: string | undefined,
  status: string
): Promise<void> {
  try {
    const col = await getCollection();
    const now = new Date().toISOString();
    await col.updateOne(
      { campaign, phone_number: phoneNumber },
      {
        $set: { batch, sid, status, updated_at: now },
        $setOnInsert: { campaign, phone_number: phoneNumber, sent_at: now },
      },
      { upsert: true }
    );
  } catch (error) {
    logger.error("Broadcast recipient record error:", error);
  }
}

/** Update a recipient's delivery status (called during delivery polling). */
export async function updateBroadcastStatus(
  campaign: string,
  sid: string,
  status: string
): Promise<void> {
  try {
    const col = await getCollection();
    await col.updateOne(
      { campaign, sid },
      { $set: { status, updated_at: new Date().toISOString() } }
    );
  } catch (error) {
    logger.error("Broadcast status update error:", error);
  }
}
