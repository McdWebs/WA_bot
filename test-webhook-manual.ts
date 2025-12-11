import twilio from "twilio";
import { config } from "./src/config";
import messageHandler from "./src/bot/messageHandler";

/**
 * Manual test to simulate button click and send time picker
 * This bypasses the webhook to test if the time picker sending works
 */
async function testManualButtonClick() {
  const phoneNumber = "+972543644512";
  
  console.log("🧪 Manual Test: Simulating button '1' click");
  console.log("=".repeat(60));
  console.log(`Phone: ${phoneNumber}`);
  console.log("Button: 1");
  console.log("");
  
  try {
    // Simulate the button click handler
    await messageHandler.handleInteractiveButton(phoneNumber, "1");
    
    console.log("✅ Time picker should have been sent!");
    console.log("Check your WhatsApp to see if the time picker template arrived.");
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    console.error(error);
  }
}

testManualButtonClick();

