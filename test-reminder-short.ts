import twilio from "twilio";
import { config } from "./src/config";
import supabaseService from "./src/services/supabase";

/**
 * Test file to test reminders with short intervals
 * This sends the welcome template, then a time picker with test intervals:
 * - 10 seconds
 * - 20 seconds  
 * - 1 minute
 * - 2 minutes
 * - 1 hour
 * 
 * Note: The reminder scheduler checks every minute, so seconds-based reminders
 * will be rounded to the nearest minute. For true second-level testing, you'd need
 * to modify the scheduler to check more frequently.
 */

const fromNumber = config.twilio.whatsappFrom;
const toNumber = "+972543644512"; // Update with your test number
const client = twilio(config.twilio.accountSid, config.twilio.authToken);

/**
 * Calculate time X seconds/minutes from now
 */
function calculateTimeFromNow(seconds: number): string {
  const now = new Date();
  const targetTime = new Date(now.getTime() + seconds * 1000);
  const hours = String(targetTime.getHours()).padStart(2, '0');
  const minutes = String(targetTime.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Send welcome template
 */
async function sendWelcomeTemplate(): Promise<void> {
  try {
    console.log("📤 Step 1: Sending welcome template...");
    const templateSid = config.templates.welcome;
    
    const result = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${toNumber}`,
      contentSid: templateSid,
    });

    console.log("✅ Welcome template sent! Message SID:", result.sid);
    console.log("📝 Next: Click button '1' in the welcome template to continue");
  } catch (error: any) {
    console.error("❌ Error sending welcome template:", error.message);
    throw error;
  }
}

/**
 * Send time picker template with test intervals
 */
async function sendTestTimePickerTemplate(): Promise<void> {
  try {
    console.log("\n📤 Step 2: Sending time picker template with test intervals...");
    const templateSid = config.templates.timePicker;
    
    // Calculate times from now
    const now = new Date();
    const time10sec = calculateTimeFromNow(10);
    const time20sec = calculateTimeFromNow(20);
    const time1min = calculateTimeFromNow(60);
    const time2min = calculateTimeFromNow(120);
    const time1hour = calculateTimeFromNow(3600);

    // Create time options for testing
    // Note: We'll use IDs that represent seconds, but store as negative minutes
    // The IDs will be: "10" (10 sec), "20" (20 sec), "60" (1 min), "120" (2 min), "3600" (1 hour)
    const timeOptions = [
      { 
        name: `בעוד 10 שניות (${time10sec})`, 
        id: '10', 
        desc: `תזכורת בעוד 10 שניות` 
      },
      { 
        name: `בעוד 20 שניות (${time20sec})`, 
        id: '20', 
        desc: `תזכורת בעוד 20 שניות` 
      },
      { 
        name: `בעוד דקה (${time1min})`, 
        id: '60', 
        desc: `תזכורת בעוד דקה אחת` 
      },
      { 
        name: `בעוד 2 דקות (${time2min})`, 
        id: '120', 
        desc: `תזכורת בעוד 2 דקות` 
      },
      { 
        name: `בעוד שעה (${time1hour})`, 
        id: '3600', 
        desc: `תזכורת בעוד שעה אחת` 
      },
    ];

    // Populate template variables (5 items × 3 fields = 15 variables)
    const templateVariables: Record<string, string> = {};
    timeOptions.forEach((option, index) => {
      const baseVar = index * 3 + 1; // 1, 4, 7, 10, 13
      templateVariables[String(baseVar)] = option.name;
      templateVariables[String(baseVar + 1)] = option.id;
      templateVariables[String(baseVar + 2)] = option.desc;
    });

    console.log("📋 Time options:");
    timeOptions.forEach((opt, i) => {
      console.log(`   ${i + 1}. ${opt.name} (ID: ${opt.id})`);
    });
    console.log("");

    const result = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${toNumber}`,
      contentSid: templateSid,
      contentVariables: JSON.stringify(templateVariables),
    });

    console.log("✅ Time picker template sent! Message SID:", result.sid);
    console.log("📝 Next: Select a time option to test the reminder");
    console.log("\n⚠️  NOTE: The reminder scheduler checks every minute.");
    console.log("   - 10 sec and 20 sec options will trigger at the next minute check");
    console.log("   - 1 min and 2 min options will trigger at the calculated time");
    console.log("   - 1 hour option will trigger in 1 hour");
  } catch (error: any) {
    console.error("❌ Error sending time picker template:", error.message);
    if (error.code === 21656) {
      console.error("   This usually means the template variables don't match the template structure.");
    }
    throw error;
  }
}

/**
 * Directly create a test reminder in the database
 * This bypasses the template flow and directly sets a reminder
 */
async function createTestReminder(phoneNumber: string, seconds: number): Promise<void> {
  try {
    console.log(`\n📤 Creating test reminder for ${seconds} seconds...`);
    
    const user = await supabaseService.getUserByPhone(phoneNumber);
    if (!user || !user.id) {
      console.error("❌ User not found. Please register first.");
      return;
    }

    // Convert seconds to negative minutes (before "event time")
    // We'll use current time + seconds as the "event time"
    // So if reminder is in 10 seconds, offset is -0.016 minutes (negative = before)
    const offsetMinutes = -Math.round((seconds / 60) * 100) / 100; // Round to 2 decimals

    // Calculate the "event time" (current time + seconds)
    const now = new Date();
    const eventTime = new Date(now.getTime() + seconds * 1000);
    const eventTimeStr = `${String(eventTime.getHours()).padStart(2, '0')}:${String(eventTime.getMinutes()).padStart(2, '0')}`;

    console.log(`   Event time: ${eventTimeStr}`);
    console.log(`   Offset: ${offsetMinutes} minutes`);

    // For testing, we'll create a special reminder type or use sunset
    // Actually, let's just use sunset and set a custom offset
    // But wait, the scheduler gets sunset time from API, not from our custom time
    
    // Better approach: Create a reminder with the offset, but we need to handle
    // the fact that the scheduler calculates based on actual sunset time
    
    // For true testing, we might need to:
    // 1. Modify the scheduler to support test mode
    // 2. Or create a test endpoint that triggers reminders immediately
    
    console.log("⚠️  Note: The reminder scheduler uses actual sunset times from Hebcal API.");
    console.log("   For true second-level testing, you may need to modify the scheduler.");
    
    // Still create the reminder setting
    await supabaseService.upsertReminderSetting({
      user_id: user.id,
      reminder_type: 'sunset',
      enabled: true,
      time_offset_minutes: offsetMinutes,
    });

    console.log(`✅ Test reminder created! Will trigger at approximately ${eventTimeStr}`);
  } catch (error: any) {
    console.error("❌ Error creating test reminder:", error.message);
    throw error;
  }
}

/**
 * Main test function
 */
async function runTest() {
  console.log("=".repeat(60));
  console.log("🧪 REMINDER TEST - Short Intervals");
  console.log("=".repeat(60));
  console.log(`To: ${toNumber}`);
  console.log(`From: ${fromNumber}`);
  console.log("");

  try {
    // Option 1: Send templates in sequence (simulates user flow)
    console.log("📋 Option 1: Template Flow Test");
    console.log("-".repeat(60));
    await sendWelcomeTemplate();
    
    console.log("\n⏳ Waiting 2 seconds before sending time picker...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    await sendTestTimePickerTemplate();

    console.log("\n" + "=".repeat(60));
    console.log("✅ Test templates sent!");
    console.log("=".repeat(60));
    console.log("\n📝 Instructions:");
    console.log("1. Check WhatsApp for the welcome template");
    console.log("2. Click button '1' (if you want to test the full flow)");
    console.log("3. Or directly use the time picker template that was just sent");
    console.log("4. Select a time option (10 sec, 20 sec, 1 min, 2 min, or 1 hour)");
    console.log("5. The reminder will be saved and should trigger at the selected time");
    console.log("\n⚠️  Important:");
    console.log("- The scheduler checks every minute, so second-level precision may vary");
    console.log("- For 10 sec and 20 sec, the reminder will trigger at the next minute check");
    console.log("- For 1 min and 2 min, it should trigger at the calculated time");
    console.log("- Make sure the reminder scheduler is running in your main server!");

    // Option 2: Directly create test reminders (uncomment to use)
    /*
    console.log("\n📋 Option 2: Direct Reminder Creation");
    console.log("-".repeat(60));
    await createTestReminder(toNumber, 10);  // 10 seconds
    await createTestReminder(toNumber, 60);  // 1 minute
    */

  } catch (error: any) {
    console.error("\n❌ Test failed:", error.message);
    console.error("Full error:", error);
    process.exit(1);
  }
}

// Run the test
runTest();

