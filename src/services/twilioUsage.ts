import twilio from "twilio";
import { config } from "../config";
import logger from "../utils/logger";

const USAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// WhatsApp / messaging categories only – so dashboard cost matches Twilio Console "WhatsApp" or "Messaging"
const WHATSAPP_MESSAGING_CATEGORIES = new Set([
  "channels-whatsapp-template-authentication",
  "channels-whatsapp-template-marketing",
  "channels-whatsapp-template-utility",
  "channels-whatsapp-service",
  "channels-whatsapp-conversation-free",
  "channels-messaging-inbound",
  "channels-messaging-outbound",
  "verify-whatsapp-template-business-initiated",
  "verify-whatsapp-conversations-business-initiated",
  "sms",
  "sms-inbound",
  "sms-outbound",
]);

let cached:
  | {
      at: number;
      today: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
      thisMonth: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
    }
  | null = null;

async function fetchUsage(): Promise<{
  today: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
  thisMonth: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
}> {
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const [todayList, thisMonthList] = await Promise.all([
    client.usage.records.today.list({ limit: 200 }),
    client.usage.records.thisMonth.list({ limit: 200 }),
  ]);

  const toSummary = (
    list: Array<{ category: string; count: string; price: number; usage?: string }>,
    messagingOnly: boolean
  ) => {
    let count = 0;
    let price = 0;
    const records = list.map((r) => {
      const n = parseInt(String(r.count || r.usage || "0"), 10) || 0;
      const p = typeof r.price === "number" ? r.price : parseFloat(String(r.price || 0)) || 0;
      const include = !messagingOnly || WHATSAPP_MESSAGING_CATEGORIES.has(r.category);
      if (include) {
        count += n;
        price += p;
      }
      return { category: r.category, count: String(r.count ?? r.usage ?? "0"), price: p };
    });
    return { count, price, records };
  };

  return {
    today: toSummary(todayList, true),
    thisMonth: toSummary(thisMonthList, true),
  };
}

export async function getTwilioUsage(): Promise<{
  today: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
  thisMonth: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
  cached: boolean;
}> {
  if (cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) {
    return { ...cached, cached: true } as any;
  }
  try {
    const data = await fetchUsage();
    cached = { at: Date.now(), ...data };
    return { ...data, cached: false };
  } catch (error) {
    logger.error("Twilio usage fetch error:", error);
    if (cached) {
      return { ...cached, cached: true } as any;
    }
    return {
      today: { count: 0, price: 0, records: [] },
      thisMonth: { count: 0, price: 0, records: [] },
      cached: false,
    };
  }
}
