import express from "express";
import { config } from "./config";
import messageHandler from "./bot/messageHandler";
import reminderScheduler from "./schedulers/reminderScheduler";
import twilioService from "./services/twilio";
import logger from "./utils/logger";
import reminderStateManager, { ReminderStateMode } from "./services/reminderStateManager";
import mongoService from "./services/mongo";

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

/**
 * Process incoming WhatsApp message in background
 * This function runs AFTER webhook response is sent
 * Optimized to send templates IMMEDIATELY for simple flows
 */
async function processWhatsAppMessage(reqBody: any): Promise<void> {
  const processStartTime = Date.now();
  
  try {
    // Check if this is a status callback (not a message)
    // Status callbacks have MessageStatus but no From field
    if (reqBody?.MessageStatus && !reqBody?.From && !reqBody?.from && !reqBody?.FROM) {
      logger.debug("Status callback received, skipping message processing");
      return;
    }

    // Extract fields (case-insensitive)
    const From = reqBody?.From || reqBody?.from || reqBody?.FROM;
    const Body = reqBody?.Body || reqBody?.body || reqBody?.BODY || "";
    const ButtonText = reqBody?.ButtonText || reqBody?.buttonText;
    const ButtonPayload = reqBody?.ButtonPayload || reqBody?.buttonPayload;
    const MessageType = reqBody?.MessageType || reqBody?.messageType;
    const ListId = reqBody?.ListId || reqBody?.listId;

    if (!From) {
      logger.error("❌ CRITICAL: From field is missing from webhook!");
      logger.debug("Webhook body:", JSON.stringify(reqBody, null, 2));
      return;
    }

    // Extract phone number (remove 'whatsapp:' prefix if present)
    const phoneNumber = From.replace("whatsapp:", "").trim();
    const messageBody = Body.trim();

    // Parse WhatsApp Interactive message correctly
    // Twilio sends MessageType as "interactive" OR "button" for button clicks
    let buttonIdentifier: string | null = null;
    const isInteractive = MessageType === "interactive" || MessageType === "button";

    // Log raw webhook data for debugging
    logger.info(`📥 Webhook data for ${phoneNumber}: MessageType="${MessageType}", Body="${Body.substring(0, 50)}", ButtonPayload="${ButtonPayload}", ButtonText="${ButtonText}", ListId="${ListId}"`);

    if (isInteractive) {
      // Interactive/Button message - use ButtonPayload (preferred) or ButtonText
      buttonIdentifier = ButtonPayload || ButtonText || null;
      
      // List Picker uses ListId
      if (!buttonIdentifier && ListId) {
        buttonIdentifier = ListId;
      }
      
      logger.info(`🔘 Interactive/Button message detected: buttonIdentifier="${buttonIdentifier}" for ${phoneNumber}`);
      } else {
      logger.info(`📝 Text message detected: "${Body.substring(0, 50)}" for ${phoneNumber}`);
    }

    // Check if user is in reminder selection mode (treat numeric input as text)
    const userState = reminderStateManager.getState(phoneNumber);
    const isInReminderSelectionMode = userState?.mode === ReminderStateMode.CHOOSE_REMINDER;
    const shouldTreatAsText = isInReminderSelectionMode && /^\d+$/.test(messageBody);
    const isButtonClick = isInteractive && !!buttonIdentifier;
    
    logger.info(`🔍 Message classification for ${phoneNumber}: isInteractive=${isInteractive}, buttonIdentifier="${buttonIdentifier}", isButtonClick=${isButtonClick}, shouldTreatAsText=${shouldTreatAsText}`);

    const templateSendStartTime = Date.now();

    // OPTIMIZATION: For simple button clicks that just send a template, send it IMMEDIATELY
    if (isButtonClick && !shouldTreatAsText && buttonIdentifier) {
      const normalizedButton = buttonIdentifier.toLowerCase().trim();
      
      // Fast path: Simple template sends that don't need DB queries
      // These buttons just send a template - no DB, no logic needed
      const fastPathButtons: Record<string, string> = {
        "manage_reminders": "manageReminders",
      };
      
      const templateKey = fastPathButtons[normalizedButton];
      if (templateKey) {
        // Send template IMMEDIATELY without any DB queries or processing
        await twilioService.sendTemplateMessage(phoneNumber, templateKey as any);
        const templateSendTime = Date.now() - templateSendStartTime;
        logger.info(`⚡ Template sent in ${templateSendTime}ms for ${phoneNumber} (fast path: ${normalizedButton})`);
        
        // Process in background (non-critical - just for logging/state updates)
        setImmediate(() => {
          messageHandler.handleInteractiveButton(phoneNumber, buttonIdentifier!).catch((err) => {
            logger.debug(`Background processing error (non-critical):`, err);
          });
        });
        return;
      }
      
      // Other button clicks - process normally (may need DB)
      logger.info(`🔘 Processing button click: "${buttonIdentifier}" from ${phoneNumber}`);
      await messageHandler.handleInteractiveButton(phoneNumber, buttonIdentifier);
        } else {
      // Regular text message - check if it's a new user (send template immediately)
      // Use cache to check user quickly without DB query
      const user = await mongoService.getUserByPhone(phoneNumber);
      
      if (!user) {
        // New user - send template IMMEDIATELY, create user in background
        await twilioService.sendTemplateMessage(phoneNumber, "manageReminders");
        const templateSendTime = Date.now() - templateSendStartTime;
        logger.info(`⚡ Template sent in ${templateSendTime}ms for new user ${phoneNumber} (fast path)`);
        
        // Create user in background (non-critical)
        setImmediate(() => {
          mongoService.createUser({
            phone_number: phoneNumber,
            status: "active",
            timezone: undefined,
            location: undefined,
          }).catch((err) => {
            logger.error(`Background user creation error:`, err);
          });
        });
        return;
      }
      
      // Existing user - process normally
      logger.info(`💬 Processing text message from ${phoneNumber}: "${messageBody.substring(0, 50)}"`);
      const response = await messageHandler.handleIncomingMessage(phoneNumber, messageBody);

          if (response && response.trim() !== "") {
            await twilioService.sendMessage(phoneNumber, response);
          }
        }

    const totalProcessTime = Date.now() - processStartTime;
    const templateSendTime = Date.now() - templateSendStartTime;
    logger.info(`✅ Message processed in ${totalProcessTime}ms (template send: ${templateSendTime}ms) for ${phoneNumber}`);
      } catch (error) {
    logger.error(`❌ Error processing WhatsApp message:`, error);
        
    // Try to send error message to user if we have phone number
        try {
      const From = reqBody?.From || reqBody?.from || reqBody?.FROM;
      if (From) {
        const phoneNumber = From.replace("whatsapp:", "").trim();
          await twilioService.sendMessage(
            phoneNumber,
            "סליחה, אירעה שגיאה. נסה שוב או שלח /menu"
          );
      }
    } catch (fallbackError) {
      logger.error(`❌ Failed to send error fallback:`, fallbackError);
    }
  }
}

// Twilio webhook endpoint for incoming WhatsApp messages
app.post("/webhook/whatsapp", (req, res) => {
  const webhookReceiveTime = Date.now();
  
  // CRITICAL: Respond to Twilio IMMEDIATELY - no await, no async, no conditionals
  // This must be the FIRST thing we do
  // Send empty 200 response (not "OK" text) to avoid Twilio sending it as a message
  res.status(200).send("");
  
  const webhookResponseTime = Date.now();
  const responseLatency = webhookResponseTime - webhookReceiveTime;
  
  logger.info(`⚡ Webhook ACK sent in ${responseLatency}ms`);

  // Process message in background (non-blocking)
  // Use setImmediate to ensure response is fully sent before processing starts
  setImmediate(() => {
    processWhatsAppMessage(req.body).catch((error) => {
      logger.error(`❌ Unhandled error in background processing:`, error);
    });
  });
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
