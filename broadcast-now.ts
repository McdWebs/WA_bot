/**
 * broadcast-now.ts
 * Run: npx ts-node broadcast-now.ts
 * Sends the broadcast template to all active users with a 1s delay between messages.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import twilio from "twilio";
import { MongoClient } from "mongodb";

// Load .env from parent folder (whBotHyudi/.env)
// Try local .env first, then parent folder
dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM!}`;
const TEMPLATE_SID = process.env.WHATSAPP_TEMPLATE_BROADCAST!;
const MONGODB_URI = process.env.MONGODB_URI!;
const DELAY_MS = 1000;

if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM || !TEMPLATE_SID || !MONGODB_URI) {
  console.error("❌ Missing environment variables. Check .env file.");
  process.exit(1);
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

async function main() {
  console.log("🔌 Connecting to MongoDB...");
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();

  const db = mongo.db();
  const users = await db.collection("users").find({ status: "active" }).toArray();
  console.log(`📋 Found ${users.length} active users`);

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    const phone = user.phone_number as string;
    try {
      const result = await client.messages.create({
        from: FROM,
        to: `whatsapp:${phone}`,
        contentSid: TEMPLATE_SID,
      });
      sent++;
      console.log(`✅ [${sent}/${users.length}] Sent to ${phone} — ${result.sid}`);
    } catch (err: any) {
      failed++;
      console.error(`❌ Failed to send to ${phone}: ${err?.message}`);
    }

    // Rate limit protection — 1 second between messages
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  await mongo.close();
  console.log(`\n📢 Done! sent=${sent}, failed=${failed}, total=${users.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
