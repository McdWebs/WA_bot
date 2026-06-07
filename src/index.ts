import express from "express";
import path from "path";
import { config } from "./config";
import messageHandler from "./bot/messageHandler";
import reminderScheduler from "./schedulers/reminderScheduler";
import twilioService from "./services/twilio";
import logger, { shortPhone } from "./utils/logger";
import reminderStateManager, { ReminderStateMode } from "./services/reminderStateManager";
import settingsStateManager, { SettingsStateMode } from "./services/settingsStateManager";
import mongoService, { connectMongo, closeMongo } from "./services/mongo";
import { Gender } from "./types";
import dashboardRouter from "./routes/dashboard";
import { clearUsageRangeCache } from "./services/twilioUsage";
// import hebcalService from "./services/hebcal";

const app = express();

// CORS for dashboard API: fully open. Reflect any origin so the Vercel dashboard
// (and local dev) are always allowed. NOTE: this does NOT affect 502s — those come
// from Render's proxy when the app is down and never carry CORS headers regardless.
app.use("/api/dashboard", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, PATCH, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

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
    const Latitude = reqBody?.Latitude ?? reqBody?.latitude;
    const Longitude = reqBody?.Longitude ?? reqBody?.longitude;

    if (!From) {
      logger.error("Webhook missing From field", { body: reqBody });
      return;
    }

    // Extract phone number (remove 'whatsapp:' prefix if present)
    const phoneNumber = From.replace("whatsapp:", "").trim();
    const messageBody = Body.trim();
    const tag = shortPhone(phoneNumber);

    // Parse WhatsApp Interactive message correctly
    // Twilio sends MessageType as "interactive" OR "button" for button clicks
    let buttonIdentifier: string | null = null;
    const isInteractive = MessageType === "interactive" || MessageType === "button";

    if (isInteractive) {
      buttonIdentifier = ButtonPayload || ButtonText || null;
      if (!buttonIdentifier && ListId) {
        buttonIdentifier = ListId;
      }
    }

    const userState = reminderStateManager.getState(phoneNumber);
    const isInReminderSelectionMode = userState?.mode === ReminderStateMode.CHOOSE_REMINDER;
    const shouldTreatAsText = isInReminderSelectionMode && /^\d+$/.test(messageBody);
    const isButtonClick = isInteractive && !!buttonIdentifier;

    logger.debug(`[${tag}] inbound`, {
      type: MessageType,
      body: Body.substring(0, 80),
      button: buttonIdentifier,
      listId: ListId,
      lat: Latitude,
      lon: Longitude,
    });

    if (isButtonClick && !shouldTreatAsText && buttonIdentifier) {
      await messageHandler.handleInteractiveButton(phoneNumber, buttonIdentifier);
      logger.info(
        `[${tag}] btn:${buttonIdentifier.slice(0, 40)} (${Date.now() - processStartTime}ms)`
      );
      return;
    }

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
        await new Promise(resolve => setTimeout(resolve, 3000));
        await twilioService.sendTemplateMessage(phoneNumber, "genderQuestion");
        logger.info(
          `[${tag}] new user → welcome+gender (${Date.now() - processStartTime}ms)`
        );
        return;
      }

      // Existing user: try to handle as command first (e.g. "הדלקת נרות", "תפילין", "הצג תזכורות", "הגדרות")
      // Capture settings & reminder state BEFORE and AFTER handling, so we can detect when a flow is active.
      const previousSettingsState = settingsStateManager.getState(phoneNumber);
      const previousReminderState = reminderStateManager.getState(phoneNumber);

      const latParsed =
        Latitude !== undefined &&
        Latitude !== null &&
        String(Latitude).trim() !== ""
          ? parseFloat(String(Latitude))
          : NaN;
      const lngParsed =
        Longitude !== undefined &&
        Longitude !== null &&
        String(Longitude).trim() !== ""
          ? parseFloat(String(Longitude))
          : NaN;
      const hasValidLocationPin =
        Number.isFinite(latParsed) &&
        Number.isFinite(lngParsed) &&
        Math.abs(latParsed) <= 90 &&
        Math.abs(lngParsed) <= 180;

      let handlerResponse = "";
      if (hasValidLocationPin) {
        const locationHandled = await messageHandler.handleIncomingLocation(
          phoneNumber,
          latParsed,
          lngParsed
        );
        if (locationHandled) {
          logger.info(
            `[${tag}] location ${latParsed.toFixed(4)},${lngParsed.toFixed(4)} (${Date.now() - processStartTime}ms)`
          );
          return;
        }
        await twilioService.sendMessage(
          phoneNumber,
          "לעדכון מיקום: בחרו ״אחר״ ברשימת הערים בתפריט, ואז שלחו מיקום (📎 ← מיקום)."
        );
        logger.info(`[${tag}] location rejected (no flow)`);
        return;
      }

      handlerResponse = await messageHandler.handleIncomingMessage(
        phoneNumber,
        messageBody
      );

      const currentSettingsState = settingsStateManager.getState(phoneNumber);
      const currentReminderState = reminderStateManager.getState(phoneNumber);

      // If handler returned a non-empty string, send it as a plain text reply.
      if (handlerResponse && handlerResponse.trim() !== "") {
        await twilioService.sendMessage(phoneNumber, handlerResponse);
        logger.info(
          `[${tag}] txt reply "${messageBody.slice(0, 30)}" (${Date.now() - processStartTime}ms)`
        );
        return;
      }

      if (previousSettingsState || currentSettingsState || previousReminderState || currentReminderState) {
        logger.info(
          `[${tag}] txt flow "${messageBody.slice(0, 30)}" (${Date.now() - processStartTime}ms)`
        );
        return;
      }

      const trimmedBody = messageBody.trim();
      const isCommandLike =
        /נרות|תפילין|שמע|תזכורת|הצג|הדלקת|חדשה|חזרה|הגדרות|candle/i.test(trimmedBody) ||
        (trimmedBody.includes("תזכורות") || trimmedBody.includes("הצג"));
      if (isCommandLike) {
        logger.info(
          `[${tag}] txt cmd "${trimmedBody.slice(0, 30)}" (${Date.now() - processStartTime}ms)`
        );
        return;
      }

      await twilioService.sendTemplateMessage(phoneNumber, "welcome");
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (!user.gender) {
        await twilioService.sendTemplateMessage(phoneNumber, "genderQuestion");
        logger.info(
          `[${tag}] restart → welcome+gender (${Date.now() - processStartTime}ms)`
        );
      } else {
        const userGender: Gender = user.gender as Gender;
        await messageHandler.sendMainMenu(phoneNumber, userGender);
        settingsStateManager.setState(phoneNumber, {
          mode: SettingsStateMode.MAIN_MENU,
        });
        await twilioService.sendMessage(
          phoneNumber,
          "⚙️ *הגדרות משתמש*\n\nבחר/י מספר פעולה:\n1️⃣ שינוי מגדר\n2️⃣ עריכת / מחיקת תזכורות\n3️⃣ שינוי מיקום\n\nאו שלח/י *ביטול* לחזרה למסך הראשי."
        );
        logger.info(
          `[${tag}] restart → welcome+menu (${userGender}, ${Date.now() - processStartTime}ms)`
        );
      }
      return;
  } catch (error) {
    logger.error("WhatsApp message processing failed:", error);

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
      logger.error("Error fallback message failed:", fallbackError);
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

  logger.debug(`Webhook ACK ${responseLatency}ms`);

  setImmediate(() => {
    processWhatsAppMessage(req.body).catch((error) => {
      logger.error("Unhandled background processing error:", error);
    });
  });
});

// Twilio status callback endpoint for message delivery status
app.post("/webhook/status", async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;

    if (MessageStatus === "failed" || MessageStatus === "undelivered" || ErrorCode) {
      logger.warn("Message delivery issue", {
        MessageSid,
        MessageStatus,
        ErrorCode,
        ErrorMessage,
      });
    } else {
      logger.debug("Message status", { MessageSid, MessageStatus });
    }

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
  logger.info(`Ready on :${PORT} (${config.nodeEnv})`);

  clearUsageRangeCache(); // so Cost & Usage never serves old cached "Other" data

  reminderScheduler.start();

  // Try MongoDB in background so it's ready for first request (don't block startup)
  connectMongo().catch((err) => {
    logger.warn("MongoDB not yet available; will retry on first use:", err?.message || err);
  });
});

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info("Shutting down");
  reminderScheduler.stop();
  await closeMongo();
  process.exit(0);
}

process.on("SIGTERM", () => {
  logger.info("SIGTERM");
  shutdown().catch((err) => {
    logger.error("Shutdown error:", err);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT");
  shutdown().catch((err) => {
    logger.error("Shutdown error:", err);
    process.exit(1);
  });
});
