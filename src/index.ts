import express from "express";
import path from "path";
import cors from "cors";
import { config } from "./config";
import messageHandler from "./bot/messageHandler";
import reminderScheduler from "./schedulers/reminderScheduler";
import twilioService from "./services/twilio";
import logger from "./utils/logger";
import reminderStateManager, { ReminderStateMode } from "./services/reminderStateManager";
import settingsStateManager, { SettingsStateMode } from "./services/settingsStateManager";
import mongoService, { connectMongo, closeMongo } from "./services/mongo";
import { Gender } from "./types";
import dashboardRouter from "./routes/dashboard";
import { clearUsageRangeCache } from "./services/twilioUsage";
// import hebcalService from "./services/hebcal";

const app = express();

// CORS for dashboard API: local dev + DASHBOARD_ORIGIN (Vercel etc.)
const LOCAL_DEV_ORIGINS = [
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
];
const allowedOrigins = new Set([
  ...LOCAL_DEV_ORIGINS,
  ...(config.dashboard.origin || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
]);

// Explicit preflight (OPTIONS) handler so PATCH and other methods are always allowed
app.use("/api/dashboard", (req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has(origin) || allowedOrigins.has(origin.replace(/\/$/, "")))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, PATCH, POST, PUT, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.status(204).end();
  }
  next();
});

app.use(
  "/api/dashboard",
  cors({
    origin: (origin, cb) => {
      if (origin == null || allowedOrigins.has(origin) || allowedOrigins.has(origin.replace(/\/$/, ""))) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    methods: ["GET", "OPTIONS", "PATCH", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "X-API-Key"],
    maxAge: 86400,
  })
);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Dashboard API (auth required via middleware)
app.use("/api/dashboard", dashboardRouter);

// Dashboard SPA (serve static build; fallback to index.html for client routing)
const dashboardDist = path.join(process.cwd(), "dashboard", "dist");
app.use("/dashboard", express.static(dashboardDist));
app.get(["/dashboard", "/dashboard/*"], (req, res, next) => {
  res.sendFile(path.join(dashboardDist, "index.html"), (err) => err && next(err));
});

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

    // Process button clicks normally (no fast path - all buttons go through messageHandler)
    if (isButtonClick && !shouldTreatAsText && buttonIdentifier) {
      logger.info(`🔘 Processing button click: "${buttonIdentifier}" from ${phoneNumber}`);
      await messageHandler.handleInteractiveButton(phoneNumber, buttonIdentifier);
    } else {
      // Regular text message - send welcome template for every conversation start
      // Use cache to check user quickly without DB query
      const user = await mongoService.getUserByPhone(phoneNumber);

      if (!user) {
        // New user - create immediately, send welcome, then ask for gender (once)
        await mongoService.createUser({
          phone_number: phoneNumber,
          status: "active",
          timezone: undefined,
          location: undefined,
        });

        // Send welcome template IMMEDIATELY, wait for it to complete, then send gender question
        await twilioService.sendTemplateMessage(phoneNumber, "welcome");
        logger.info(`✅ Welcome template sent, waiting before sending gender question for ${phoneNumber}`);

        // Wait longer to ensure welcome template is fully processed and delivered before sending menu
        // WhatsApp may process messages out of order if sent too quickly
        // Increased delay to 3 seconds to ensure proper sequencing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ask for gender once; actual menu will be sent after user clicks
        await twilioService.sendTemplateMessage(phoneNumber, "genderQuestion");
        const templateSendTime = Date.now() - templateSendStartTime;
        logger.info(`⚡ Welcome + Gender Question templates sent in ${templateSendTime}ms for new user ${phoneNumber} (fast path)`);
        return;
      }

      // Existing user: try to handle as command first (e.g. "הדלקת נרות", "תפילין", "הצג תזכורות", "הגדרות")
      // Capture settings state BEFORE and AFTER handling, so we can detect when a settings interaction just happened,
      // even if the handler cleared the settings state (e.g. option 2/3 which exit settings mode).
      const previousSettingsState = settingsStateManager.getState(phoneNumber);
      await messageHandler.handleIncomingMessage(phoneNumber, messageBody);

      const currentSettingsState = settingsStateManager.getState(phoneNumber);
      if (previousSettingsState || currentSettingsState) {
        logger.info(
          `⚙️ User ${phoneNumber} is in or just used settings mode (prev=${previousSettingsState?.mode || "none"}, current=${currentSettingsState?.mode || "none"}) – skipping welcome/menu auto-send`
        );
        return;
      }

      const trimmedBody = messageBody.trim();
      const isCommandLike =
        /נרות|תפילין|שמע|תזכורת|הצג|הדלקת|חדשה|חזרה|הגדרות|candle/i.test(trimmedBody) ||
        (trimmedBody.includes("תזכורות") || trimmedBody.includes("הצג"));
      if (isCommandLike) {
        const totalProcessTime = Date.now() - processStartTime;
        logger.info(`✅ Command-like text processed for ${phoneNumber} in ${totalProcessTime}ms (no welcome+menu)`);
        return;
      }

      // No command matched – send welcome template, then menu/settings for existing users
      await twilioService.sendTemplateMessage(phoneNumber, "welcome");
      logger.info(`✅ Welcome template sent, waiting before next step for ${phoneNumber}`);

      // Wait longer to ensure welcome template is fully processed and delivered before sending menu/settings
      // WhatsApp may process messages out of order if sent too quickly
      // Increased delay to 3 seconds to ensure proper sequencing
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (!user.gender) {
        // Ask for gender only once per user
        await twilioService.sendTemplateMessage(phoneNumber, "genderQuestion");
        const templateSendTime = Date.now() - templateSendStartTime;
        logger.info(
          `⚡ Welcome + Gender Question templates sent in ${templateSendTime}ms for user ${phoneNumber} (missing gender)`
        );
      } else {
        const userGender: Gender = user.gender as Gender;
        await messageHandler.sendMainMenu(phoneNumber, userGender);

        // Immediately follow the menu with the free-form settings menu
        settingsStateManager.setState(phoneNumber, {
          mode: SettingsStateMode.MAIN_MENU,
        });
        await twilioService.sendMessage(
          phoneNumber,
          "⚙️ *הגדרות משתמש*\n\nבחר/י מספר פעולה:\n1️⃣ שינוי מגדר\n2️⃣ עריכת / מחיקת תזכורות\n3️⃣ שינוי מיקום\n\nאו שלח/י *ביטול* לחזרה למסך הראשי."
        );

        const templateSendTime = Date.now() - templateSendStartTime;
        logger.info(
          `⚡ Welcome + Menu + Settings text sent in ${templateSendTime}ms for user ${phoneNumber} (conversation start with gender ${userGender})`
        );
      }

      const totalProcessTime = Date.now() - processStartTime;
      logger.info(`✅ Welcome + Menu (+ Settings when applicable) sent in ${totalProcessTime}ms for ${phoneNumber}`);
      return;
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

    const { updateMessageLogStatus } = await import("./services/messageLog");
    if (MessageSid && MessageStatus) {
      updateMessageLogStatus(MessageSid, MessageStatus, ErrorCode).catch(() => { });
    }
  } catch (error) {
    logger.error("Error handling status callback:", error);
    res.status(500).send("Internal server error");
  }
});

// Start server immediately; MongoDB connects on first use (or in background)
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);

  clearUsageRangeCache(); // so Cost & Usage never serves old cached "Other" data

  // Start reminder scheduler (will use MongoDB when it connects)
  reminderScheduler.start();

  logger.info("WhatsApp Reminders Bot is ready!");

  // Try MongoDB in background so it's ready for first request (don't block startup)
  connectMongo().catch((err) => {
    logger.warn("MongoDB not yet available; will retry on first use:", err?.message || err);
  });
});

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info("Shutting down gracefully");
  reminderScheduler.stop();
  await closeMongo();
  process.exit(0);
}

process.on("SIGTERM", () => {
  logger.info("SIGTERM received");
  shutdown().catch((err) => {
    logger.error("Shutdown error:", err);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received");
  shutdown().catch((err) => {
    logger.error("Shutdown error:", err);
    process.exit(1);
  });
});
