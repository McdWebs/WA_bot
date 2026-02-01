import { Collection, ObjectId } from "mongodb";
import logger from "../utils/logger";
import { getDb } from "./mongo";

export interface MessageLogEntry {
  _id?: ObjectId;
  phone_number: string;
  twilio_sid: string;
  direction: "outbound";
  type: "template" | "freeform";
  template_key?: string;
  sent_at: string;
  status?: string;
  error_code?: number | string;
}

function getMessageLogCollection(): Promise<Collection<MessageLogEntry>> {
  return getDb().then((d) => d.collection<MessageLogEntry>("message_log"));
}

export async function appendMessageLog(entry: Omit<MessageLogEntry, "direction">): Promise<void> {
  try {
    const col = await getMessageLogCollection();
    await col.insertOne({
      ...entry,
      direction: "outbound",
    });
    logger.info(`Message logged: sid=${entry.twilio_sid} to ${entry.phone_number} type=${entry.type}`);
  } catch (error) {
    logger.error("Message log append error:", error);
  }
}

export async function updateMessageLogStatus(
  twilioSid: string,
  status: string,
  errorCode?: number | string
): Promise<void> {
  try {
    const col = await getMessageLogCollection();
    const update: Partial<MessageLogEntry> = { status };
    if (errorCode !== undefined) update.error_code = errorCode;
    await col.updateOne({ twilio_sid: twilioSid }, { $set: update });
  } catch (error) {
    logger.error("Message log status update error:", error);
  }
}

export async function getMessageStats(options?: {
  startDate?: string;
  endDate?: string;
  phoneNumber?: string;
}): Promise<{
  total: number;
  byDay: { date: string; count: number }[];
  byType: Record<string, number>;
  recent: MessageLogEntry[];
}> {
  const col = await getMessageLogCollection();
  const filter: any = {};
  if (options?.startDate || options?.endDate) {
    filter.sent_at = {};
    if (options.startDate) filter.sent_at.$gte = options.startDate;
    if (options.endDate) filter.sent_at.$lte = options.endDate;
  }
  if (options?.phoneNumber) filter.phone_number = options.phoneNumber;

  const [total, byDayAgg, byTypeAgg, recent] = await Promise.all([
    col.countDocuments(filter),
    col
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: { $toDate: "$sent_at" } } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 90 },
      ])
      .toArray(),
    col
      .aggregate([{ $match: filter }, { $group: { _id: "$type", count: { $sum: 1 } } }])
      .toArray(),
    col.find(filter).sort({ sent_at: -1 }).limit(50).toArray(),
  ]);

  const byDay = (byDayAgg as any[]).map((r) => ({ date: r._id, count: r.count }));
  const byType: Record<string, number> = {};
  (byTypeAgg as any[]).forEach((r) => {
    byType[r._id || "unknown"] = r.count;
  });

  return { total, byDay, byType, recent };
}

export async function getMessageCountByPhone(phoneNumber: string): Promise<number> {
  const col = await getMessageLogCollection();
  return col.countDocuments({ phone_number: phoneNumber });
}
