import twilio from "twilio";
import { config } from "./src/config";
import hebcalService from "./src/services/hebcal";

/**
 * Test function to directly send time picker template (for testing purposes only)
 * In production, this should only be sent after user clicks button "1" in welcome template
 */
async function testSendTimePickerTemplate() {
  const fromNumber = config.twilio.whatsappFrom;
  const toNumber = "+972543644512";
  const templateSid = config.templates.timePicker;
  const location = "Jerusalem";

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  try {
    console.log("📤 Testing Time Picker Template...");
    console.log(`From: whatsapp:${fromNumber}`);
    console.log(`To: whatsapp:${toNumber}`);
    console.log(`Template SID: ${templateSid}`);
    console.log(`Location: ${location}`);
    console.log("");

    // Get sunset data from Hebcal
    console.log("🌅 Fetching sunset data from Hebcal...");
    const sunsetData = await hebcalService.getSunsetData(location);

    if (!sunsetData) {
      console.error("❌ Could not fetch sunset data");
      return;
    }

    console.log(`✅ Sunset time: ${sunsetData.sunset}`);
    console.log(`✅ Date: ${sunsetData.date}`);
    if (sunsetData.candle_lighting) {
      console.log(`✅ Candle lighting: ${sunsetData.candle_lighting}`);
    }
    console.log("");

    // Prepare template variables for List Picker template
    // The template has 5 list items, each with: name, id, description
    // Structure: Item 1 ({{1}}, {{2}}, {{3}}), Item 2 ({{4}}, {{5}}, {{6}}), etc.
    // We'll create time options based on the sunset time
    const sunsetTime = sunsetData.sunset || '18:00';
    const [hours, minutes] = sunsetTime.split(':').map(Number);
    
    // Helper function to calculate time before sunset
    const calculateTimeBefore = (minutesBefore: number): string => {
      const totalMinutes = hours * 60 + minutes;
      const reminderMinutes = totalMinutes - minutesBefore;
      const reminderHours = Math.floor(reminderMinutes / 60);
      const reminderMins = reminderMinutes % 60;
      return `${String(reminderHours).padStart(2, '0')}:${String(reminderMins).padStart(2, '0')}`;
    };
    
    // Create time options (at sunset, 15 min before, 30 min before, 45 min before, 1 hour before)
    const timeOptions = [
      { 
        name: `בזמן השקיעה (${sunsetTime})`, 
        id: '0', 
        desc: `תזכורת בדיוק בזמן השקיעה` 
      },
      { 
        name: `15 דקות לפני (${calculateTimeBefore(15)})`, 
        id: '15', 
        desc: `תזכורת 15 דקות לפני השקיעה` 
      },
      { 
        name: `30 דקות לפני (${calculateTimeBefore(30)})`, 
        id: '30', 
        desc: `תזכורת 30 דקות לפני השקיעה` 
      },
      { 
        name: `45 דקות לפני (${calculateTimeBefore(45)})`, 
        id: '45', 
        desc: `תזכורת 45 דקות לפני השקיעה` 
      },
      { 
        name: `שעה לפני (${calculateTimeBefore(60)})`, 
        id: '60', 
        desc: `תזכורת שעה לפני השקיעה` 
      },
    ];
    
    // Populate all 15 variables (5 items × 3 fields each)
    // Item 1: {{1}}=name, {{2}}=id, {{3}}=description
    // Item 2: {{4}}=name, {{5}}=id, {{6}}=description
    // Item 3: {{7}}=name, {{8}}=id, {{9}}=description
    // Item 4: {{10}}=name, {{11}}=id, {{12}}=description
    // Item 5: {{13}}=name, {{14}}=id, {{15}}=description
    const templateVariables: Record<string, string> = {};
    timeOptions.forEach((option, index) => {
      const baseVar = index * 3 + 1; // 1, 4, 7, 10, 13
      templateVariables[String(baseVar)] = option.name;      // Item name
      templateVariables[String(baseVar + 1)] = option.id;     // Item ID
      templateVariables[String(baseVar + 2)] = option.desc;   // Item description
    });

    console.log("📋 Template variables (numbered):", templateVariables);
    console.log("");

    // First, try sending without variables to test if template works
    console.log("🧪 Testing template without variables first...");
    try {
      const testResult = await client.messages.create({
        from: `whatsapp:${fromNumber}`,
        to: `whatsapp:${toNumber}`,
        contentSid: templateSid,
      });
      console.log("✅ Template works without variables! Message SID:", testResult.sid);
      console.log("⚠️  This template might not have variables defined.");
      console.log("");
    } catch (testError: any) {
      console.log("ℹ️  Template requires variables or has an issue:", testError.message);
      console.log("");
    }

    // Now try with variables using different formats
    console.log("🧪 Testing with variables...");
    
    // Try format 1: JSON string with numbered keys
    const format1 = JSON.stringify(templateVariables);
    console.log("Format 1 (JSON string):", format1);
    
    // Try format 2: Direct object (in case Twilio SDK handles it)
    console.log("Format 2 (Object):", templateVariables);
    
    // Send the time picker template
    const messagePayload: any = {
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${toNumber}`,
      contentSid: templateSid,
    };

    // Try different formats - start with JSON string
    messagePayload.contentVariables = format1;
    console.log("📤 Sending with contentVariables:", messagePayload.contentVariables);

    const result = await client.messages.create(messagePayload);

    console.log("✅ Time picker template message created successfully!");
    console.log(`Message SID: ${result.sid}`);
    console.log(`Status: ${result.status}`);
    console.log(`Date Created: ${result.dateCreated}`);
    console.log("");

    // Check message status after a short delay
    console.log("Checking message status...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const messageStatus = await client.messages(result.sid).fetch();
    console.log(`Current Status: ${messageStatus.status}`);
    console.log(`Error Code: ${messageStatus.errorCode || "None"}`);
    console.log(`Error Message: ${messageStatus.errorMessage || "None"}`);

    if (
      messageStatus.status === "failed" ||
      messageStatus.status === "undelivered"
    ) {
      console.log("\n❌ Message failed to deliver!");
    } else if (
      messageStatus.status === "sent" ||
      messageStatus.status === "delivered"
    ) {
      console.log("\n✅ Time picker template delivered successfully!");
    } else {
      console.log(
        `\n⏳ Message status: ${messageStatus.status} (may still be processing)`
      );
    }
  } catch (error: any) {
    console.error("\n❌ Error sending time picker template:");
    console.error(`Error Code: ${error.code}`);
    console.error(`Error Message: ${error.message}`);
    
    if (error.code === 21656) {
      console.error("\n💡 Possible issues:");
      console.error("1. Template might not have variables defined");
      console.error("2. Variable numbers/names don't match template");
      console.error("3. Template might need to be approved with variables");
      console.error("\n🔍 Try checking your template in Twilio Console:");
      console.error("   - Go to Content > Templates");
      console.error("   - Find your template and check if it has variables");
      console.error("   - Variables should be numbered like {{1}}, {{2}}, etc.");
      console.error("\n🧪 Trying without variables as fallback...");
      
      // Try sending without variables
      try {
        const fallbackResult = await client.messages.create({
          from: `whatsapp:${fromNumber}`,
          to: `whatsapp:${toNumber}`,
          contentSid: templateSid,
        });
        console.log("✅ Template sent successfully WITHOUT variables!");
        console.log("⚠️  Your template doesn't support variables, or they're not configured correctly.");
        console.log(`Message SID: ${fallbackResult.sid}`);
      } catch (fallbackError: any) {
        console.error("❌ Even without variables, template failed:", fallbackError.message);
      }
    }
    
    console.error("\nFull error:", error);
  }
}

async function testSendMessage() {
  const fromNumber = config.twilio.whatsappFrom;
  const toNumber = "+972543644512";
  const templateSid = config.templates.welcome;

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  try {
    console.log("📤 Sending test welcome template message...");
    console.log(`From: whatsapp:${fromNumber}`);
    console.log(`To: whatsapp:${toNumber}`);
    console.log(`Template SID: ${templateSid}`);
    console.log("");

    const result = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${toNumber}`,
      contentSid: templateSid,
    });

    console.log("✅ Message created successfully!");
    console.log(`Message SID: ${result.sid}`);
    console.log(`Status: ${result.status}`);
    console.log(`Date Created: ${result.dateCreated}`);
    console.log("");

    // Check message status after a short delay
    console.log("Checking message status...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const messageStatus = await client.messages(result.sid).fetch();
    console.log(`Current Status: ${messageStatus.status}`);
    console.log(`Error Code: ${messageStatus.errorCode || "None"}`);
    console.log(`Error Message: ${messageStatus.errorMessage || "None"}`);

    if (
      messageStatus.status === "failed" ||
      messageStatus.status === "undelivered"
    ) {
      console.log("\n❌ Message failed to deliver!");
      console.log("\nCommon reasons:");
      console.log("1. Recipient hasn't opted in to receive messages");
      console.log(
        "2. Recipient needs to send you a message first (24-hour window)"
      );
      console.log("3. Number format is incorrect");
      console.log("4. Twilio WhatsApp sandbox restrictions");
      console.log(
        "\n💡 Solution: Have the recipient send a message to your Twilio WhatsApp number first."
      );
    } else if (
      messageStatus.status === "sent" ||
      messageStatus.status === "delivered"
    ) {
      console.log("\n✅ Message delivered successfully!");
    } else {
      console.log(
        `\n⏳ Message status: ${messageStatus.status} (may still be processing)`
      );
    }
  } catch (error: any) {
    console.error("\n❌ Error sending message:");
    console.error(`Error Code: ${error.code}`);
    console.error(`Error Message: ${error.message}`);

    if (error.code === 21211) {
      console.error("\n⚠️  Invalid recipient number format");
    } else if (error.code === 21608) {
      console.error("\n⚠️  Unsubscribed recipient - they need to opt-in");
    } else if (error.code === 63007) {
      console.error(
        "\n⚠️  Message blocked - recipient needs to send you a message first"
      );
    } else if (error.code === 63016) {
      console.error("\n⚠️  Invalid WhatsApp number");
    }

    console.error("\nFull error:", error);
    process.exit(1);
  }
}

/**
 * Test function to send complete template (for testing purposes only)
 * In production, this should only be sent after user selects a time from time_picker template
 */
async function testSendCompleteTemplate() {
  const fromNumber = config.twilio.whatsappFrom;
  const toNumber = "+972543644512";
  const templateSid = config.templates.complete;
  const location = "Jerusalem";
  const selectedTimeId = "15"; // Example: 15 minutes before sunset

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  try {
    console.log("📤 Testing Complete Template...");
    console.log(`From: whatsapp:${fromNumber}`);
    console.log(`To: whatsapp:${toNumber}`);
    console.log(`Template SID: ${templateSid}`);
    console.log(`Location: ${location}`);
    console.log(`Selected Time ID: ${selectedTimeId}`);
    console.log("");

    // Get sunset data from Hebcal
    console.log("🌅 Fetching sunset data from Hebcal...");
    const sunsetData = await hebcalService.getSunsetData(location);

    if (!sunsetData) {
      console.error("❌ Could not fetch sunset data");
      return;
    }

    console.log(`✅ Sunset time: ${sunsetData.sunset}`);
    console.log(`✅ Date: ${sunsetData.date}`);
    console.log("");

    // Map time ID to description
    const timeDescriptions: Record<string, string> = {
      '0': 'בזמן השקיעה',
      '15': '15 דקות לפני השקיעה',
      '30': '30 דקות לפני השקיעה',
      '45': '45 דקות לפני השקיעה',
      '60': 'שעה לפני השקיעה',
    };

    const timeDescription = timeDescriptions[selectedTimeId] || `תזכורת ${selectedTimeId} דקות לפני השקיעה`;
    const sunsetTime = sunsetData.sunset || '18:00';

    // Prepare template variables
    const templateVariables: Record<string, string> = {
      '1': 'זמני שקיעה',
      '2': timeDescription,
      '3': sunsetTime,
      '4': location,
    };

    console.log("📋 Template Variables:");
    console.log(JSON.stringify(templateVariables, null, 2));
    console.log("");

    // Try sending with variables first
    try {
      const messagePayload: any = {
        from: `whatsapp:${fromNumber}`,
        to: `whatsapp:${toNumber}`,
        contentSid: templateSid,
        contentVariables: JSON.stringify(templateVariables),
      };

      console.log("📤 Sending complete template with variables...");
      const result = await client.messages.create(messagePayload);
      console.log(`✅ Complete template sent successfully!`);
      console.log(`Message SID: ${result.sid}`);
    } catch (templateError: any) {
      if (templateError.code === 21656) {
        console.warn("⚠️  Template variables error (21656) - trying without variables");
        try {
          const messagePayload: any = {
            from: `whatsapp:${fromNumber}`,
            to: `whatsapp:${toNumber}`,
            contentSid: templateSid,
          };
          const result = await client.messages.create(messagePayload);
          console.log(`✅ Complete template sent without variables!`);
          console.log(`Message SID: ${result.sid}`);
        } catch (noVarError: any) {
          console.error("❌ Failed to send template even without variables");
          throw noVarError;
        }
      } else {
        throw templateError;
      }
    }
  } catch (error: any) {
    console.error("\n❌ Error sending complete template:");
    if (error.code === 21656) {
      console.error("\n⚠️  Error Code: 21656 - Invalid Content Variables");
      console.error("This usually means the template variables don't match the template structure.");
      console.error("Check that your template variables match the template's expected format.");
    } else if (error.code === 63016) {
      console.error("\n⚠️  Invalid WhatsApp number");
    }
    console.error("\nFull error:", error);
    process.exit(1);
  }
}

// Run tests
// To test the full chain:
// 1. Run this script to send the welcome template
// 2. Click button "1" in the welcome template on WhatsApp
// 3. The webhook will receive the button click and send the time picker template automatically
// 4. Click a time option (0, 15, 30, 45, or 60) in the time picker template
// 5. The webhook will receive the time selection and send the complete template automatically
(async () => {
  console.log("=".repeat(60));
  console.log("TEST: Complete Template Chain Flow");
  console.log("=".repeat(60));
  console.log("📝 This will send the welcome template.");
  console.log("📝 After you click button '1' in the welcome template,");
  console.log("📝 the time picker template will be sent automatically via webhook.");
  console.log("📝 After you select a time in the time picker,");
  console.log("📝 the complete template will be sent automatically via webhook.");
  console.log("=".repeat(60));
  console.log("");
  
  await testSendMessage();
  
  console.log("\n");
  console.log("=".repeat(60));
  console.log("✅ Welcome template sent!");
  console.log("=".repeat(60));
  console.log("📱 Next steps to test the complete chain:");
  console.log("1. Check your WhatsApp for the welcome template");
  console.log("2. Click button '1' (Sunset Times) in the template");
  console.log("   → The time picker template will be sent automatically");
  console.log("3. Select a time option (0, 15, 30, 45, or 60) in the time picker");
  console.log("   → The complete template will be sent automatically");
  console.log("4. Check your server logs to see the webhook being triggered");
  console.log("");
  console.log("💡 To test templates directly (bypassing webhook):");
  console.log("   - Uncomment testSendTimePickerTemplate() to test time picker");
  console.log("   - Uncomment testSendCompleteTemplate() to test complete template");
  console.log("=".repeat(60));
  
  // Uncomment the lines below to test templates directly (for debugging)
  // await testSendTimePickerTemplate();
  // await testSendCompleteTemplate();
})();
