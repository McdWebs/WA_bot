import express from "express";
import { config } from "./config";
import messageHandler from "./bot/messageHandler";
import reminderScheduler from "./schedulers/reminderScheduler";
import twilioService from "./services/twilio";
import logger from "./utils/logger";

const app = express();

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Test endpoint to verify webhook is accessible
app.get("/webhook/test", (req, res) => {
  const webhookUrl = config.webhookUrl 
    ? `${config.webhookUrl}/webhook/whatsapp`
    : "Not configured (set WEBHOOK_URL environment variable)";
  
  res.status(200).json({
    message: "Webhook endpoint is accessible!",
    timestamp: new Date().toISOString(),
    webhookUrl: webhookUrl,
    webhookStatusUrl: config.webhookUrl 
      ? `${config.webhookUrl}/webhook/status`
      : "Not configured",
  });
});

// Debug middleware - parse body first, then log (CRITICAL: body parsing must happen before logging)
app.post("/webhook/whatsapp", express.urlencoded({ extended: true }), (req, res, next) => {
  logger.info("=== WEBHOOK REQUEST RECEIVED ===");
  logger.info("Method:", req.method);
  logger.info("Content-Type:", req.headers["content-type"]);
  logger.info("Body keys:", Object.keys(req.body || {}));
  logger.info("Body:", JSON.stringify(req.body, null, 2));
  logger.info("================================");
  next();
});

// Twilio webhook endpoint for incoming WhatsApp messages
app.post("/webhook/whatsapp", async (req, res) => {
  // Log that we received a webhook
  logger.info("🔔 WEBHOOK CALLED - Received POST request to /webhook/whatsapp");
  logger.info(`Full request body: ${JSON.stringify(req.body, null, 2)}`);
  logger.info(`Body type: ${typeof req.body}`);
  logger.info(`Body keys: ${JSON.stringify(Object.keys(req.body || {}))}`);

  // Respond to Twilio immediately to avoid timeout
  // Use plain text response for WhatsApp webhooks (not XML/TwiML)
  // res.status(200).contentType('text/plain').send("OK");

  try {
    // Try different field name variations (Twilio might send different cases)
    const From = req.body?.From || req.body?.from || req.body?.FROM;
    const Body = req.body?.Body || req.body?.body || req.body?.BODY;
    const MessageSid = req.body?.MessageSid || req.body?.messageSid || req.body?.MessageSID;
    const ButtonText = req.body?.ButtonText || req.body?.buttonText;
    const ButtonPayload = req.body?.ButtonPayload || req.body?.buttonPayload;
    const MessageType = req.body?.MessageType || req.body?.messageType;
    const ListId = req.body?.ListId || req.body?.listId;

    logger.info("Extracted fields:", {
      From,
      Body,
      MessageSid,
      ButtonText,
      ButtonPayload,
      MessageType,
      ListId,
    });

    if (!From) {
      logger.error("❌ CRITICAL: From field is missing from webhook!");
      logger.error(`Raw req.body: ${JSON.stringify(req.body, null, 2)}`);
      logger.error(`All body keys: ${JSON.stringify(Object.keys(req.body || {}))}`);
      
      // Try to extract phone number from Payload if it's a JSON string (Twilio error webhooks)
      let phoneNumber = null;
      if (req.body?.Payload) {
        try {
          const payload = JSON.parse(req.body.Payload);
          if (payload?.webhook?.request?.parameters?.From) {
            phoneNumber = payload.webhook.request.parameters.From.replace("whatsapp:", "").trim();
            logger.info(`Found phone in Payload From: ${phoneNumber}`);
          } else if (payload?.webhook?.request?.parameters?.WaId) {
            phoneNumber = `+${payload.webhook.request.parameters.WaId}`;
            logger.info(`Found phone in Payload WaId: ${phoneNumber}`);
          }
        } catch (e) {
          logger.error("Failed to parse Payload:", e);
        }
      }
      
      // Try other fields as fallback
      if (!phoneNumber) {
        const possiblePhoneFields = [
          req.body?.WaId,
          req.body?.waId,
        ];
        
        const foundPhone = possiblePhoneFields.find(field => field && (field.includes('+') || /^\d+$/.test(field)));
        
        if (foundPhone) {
          phoneNumber = foundPhone.includes('+') ? foundPhone : `+${foundPhone}`;
          logger.info(`Found phone in alternative field: ${phoneNumber}`);
        }
      }
      
      if (phoneNumber) {
        try {
          await twilioService.sendMessage(
            phoneNumber,
            "✅ Webhook received! Processing your message..."
          );
          logger.info(`✅ Sent response using extracted phone number`);
        } catch (sendError) {
          logger.error(`Failed to send response:`, sendError);
        }
      } else {
        logger.error("Could not find phone number in any field");
      }
      
      return;
    }

    // Extract phone number (remove 'whatsapp:' prefix if present)
    const phoneNumber = From.replace("whatsapp:", "").trim();

    // Handle interactive template button clicks
    // ButtonText, ButtonPayload, ListId (for list picker), or Body can contain the button identifier
    // Extract button identifier - prioritize ButtonPayload (stable ID), then ButtonText
    let buttonIdentifier = ButtonPayload || ButtonText;
    const messageBody = Body?.trim() || "";

    // If no explicit button fields, try to extract button from Body
    // Handle cases like "1", "1.", "You said :1", "0", "15", "30", "45", "60", etc.
    // NOTE: "You said :1" is Twilio's default response when webhook isn't configured
    if (!buttonIdentifier && messageBody) {
      // Try to extract button from "You said :X" pattern (Twilio echo when webhook not configured)
      // Supports both single digits (1-9) and time picker IDs (0, 15, 30, 45, 60)
      const twilioEchoMatch = messageBody.match(
        /You said\s*:?\s*([1-9]|0|15|30|45|60)/i
      );
      if (twilioEchoMatch) {
        buttonIdentifier = twilioEchoMatch[1];
        logger.warn(
          `⚠️ Detected Twilio echo message - webhook may not be configured! Message: "${messageBody}"`
        );
      } else {
        // Try to extract just the number/button identifier
        // Match single digits (1-9) or time picker IDs (0, 15, 30, 45, 60)
        const buttonMatch = messageBody.match(
          /(?:^|:|\s)([1-9][\.:]?|0|15|30|45|60)(?:\s|$|\.)/
        );
        if (buttonMatch) {
          buttonIdentifier = buttonMatch[1].replace(/[\.:]$/, "");
        } else {
          buttonIdentifier = messageBody;
        }
      }
    }

    // If this is a List Picker selection, use ListId as the button identifier
    if (!buttonIdentifier && MessageType === "interactive" && ListId) {
      buttonIdentifier = ListId;
    }

    logger.info(`Processing message from ${phoneNumber}:`, {
      Body: messageBody,
      ButtonText,
      ButtonPayload,
      extractedButton: buttonIdentifier,
      fullBody: req.body,
    });

    // Process message asynchronously
    (async () => {
      try {
        // Check if this is a button click from an interactive template
        // CRITICAL: Only treat as button click if we have explicit ButtonText/ButtonPayload/ListId
        // OR if Body is EXACTLY a number that indicates a button selection
        // This ensures we ONLY respond to actual button clicks, not regular messages
        const isExplicitButtonClick = !!(ButtonText || ButtonPayload || ListId);
        const trimmedBody = messageBody.trim();
        // Check for single digit (1-9) or time picker selections (0, 15, 30, 45, 60)
        const isSimpleNumberClick =
          trimmedBody &&
          (/^[1-9][\.:]?$/.test(trimmedBody) ||
            /^(0|15|30|45|60)$/.test(trimmedBody));
        // Also detect "You said :1" pattern (Twilio echo when webhook not configured)
        const isTwilioEcho = /You said\s*:?\s*([1-9]|0|15|30|45|60)/i.test(
          trimmedBody
        );
        const isButtonClick =
          isExplicitButtonClick || isSimpleNumberClick || isTwilioEcho;

        logger.info(`📥 Message analysis:`, {
          hasButtonText: !!ButtonText,
          hasButtonPayload: !!ButtonPayload,
          body: messageBody,
          isExplicitButton: isExplicitButtonClick,
          isSimpleNumber: isSimpleNumberClick,
          isButtonClick: isButtonClick,
          buttonIdentifier: buttonIdentifier,
        });

        if (isButtonClick && buttonIdentifier) {
          logger.info(
            `🔘 Detected button click: "${buttonIdentifier}" (ButtonText: ${ButtonText}, ButtonPayload: ${ButtonPayload}, Body: "${messageBody}")`
          );
          await messageHandler.handleInteractiveButton(
            phoneNumber,
            buttonIdentifier
          );
        } else {
          // Handle regular message
          logger.info(
            `💬 Handling as regular message (not a button click): "${messageBody}"`
          );
          const response = await messageHandler.handleIncomingMessage(
            phoneNumber,
            messageBody
          );

          // If response is empty, template was sent (don't send text message)
          if (response && response.trim() !== "") {
            logger.info(
              `Sending response to ${phoneNumber}: ${response.substring(
                0,
                50
              )}...`
            );
            await twilioService.sendMessage(phoneNumber, response);
          } else {
            logger.info(
              `Template was sent to ${phoneNumber}, skipping text message`
            );
          }
        }

        logger.info(`Response sent successfully to ${phoneNumber}`);
      } catch (error) {
        logger.error(`Error processing message from ${phoneNumber}:`, error);
        
        // Always send fallback message to user
        try {
          await twilioService.sendMessage(
            phoneNumber,
            "סליחה, אירעה שגיאה. נסה שוב או שלח /menu"
          );
          logger.info(`✅ Sent error fallback message to ${phoneNumber}`);
        } catch (fallbackError) {
          logger.error(`❌ Failed to send fallback message to ${phoneNumber}:`, fallbackError);
        }
      }
    })();
  } catch (error) {
    logger.error("Error handling webhook:", error);
  }
});

// Twilio status callback endpoint for message delivery status
app.post("/webhook/status", async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;

    logger.info("Message status update:", {
      MessageSid,
      MessageStatus,
      ErrorCode,
      ErrorMessage,
    });

    // Respond to Twilio
    // res.status(200).send("OK");
  } catch (error) {
    logger.error("Error handling status callback:", error);
    res.status(500).send("Internal server error");
  }
});

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);

  // Start reminder scheduler
  reminderScheduler.start();

  logger.info("WhatsApp Reminders Bot is ready!");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  reminderScheduler.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down gracefully");
  reminderScheduler.stop();
  process.exit(0);
});
