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

/** Phone numbers that have already received this campaign successfully. */
export async function getAlreadySentPhones(campaign: string): Promise<Set<string>> {
  const col = await getCollection();
  const docs = await col
    .find({ campaign, status: { $in: HEALTHY_STATUSES } })
    .project({ phone_number: 1 })
    .toArray();
  return new Set(docs.map((d: any) => d.phone_number as string));
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
