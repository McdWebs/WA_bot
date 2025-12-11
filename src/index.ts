import express from 'express';
import { config } from './config';
import messageHandler from './bot/messageHandler';
import reminderScheduler from './schedulers/reminderScheduler';
import twilioService from './services/twilio';
import logger from './utils/logger';

const app = express();

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint to verify webhook is accessible
app.get('/webhook/test', (req, res) => {
  res.status(200).json({ 
    message: 'Webhook endpoint is accessible!',
    timestamp: new Date().toISOString(),
    webhookUrl: 'https://penni-mesne-williemae.ngrok-free.dev/webhook/whatsapp'
  });
});

// Debug endpoint - log all incoming requests
app.use('/webhook/whatsapp', (req, res, next) => {
  logger.info('=== WEBHOOK REQUEST RECEIVED ===');
  logger.info('Method:', req.method);
  logger.info('Headers:', JSON.stringify(req.headers, null, 2));
  logger.info('Body:', JSON.stringify(req.body, null, 2));
  logger.info('Query:', JSON.stringify(req.query, null, 2));
  logger.info('================================');
  next();
});

// Twilio webhook endpoint for incoming WhatsApp messages
app.post('/webhook/whatsapp', async (req, res) => {
  // Log that we received a webhook
  logger.info('🔔 WEBHOOK CALLED - Received POST request to /webhook/whatsapp');
  logger.info('Full request body:', JSON.stringify(req.body, null, 2));
  
  // Respond to Twilio immediately to avoid timeout
  res.status(200).send('OK');

  try {
    const { From, Body, MessageSid, ButtonText, ButtonPayload } = req.body;

    logger.info('Received webhook:', { From, Body, MessageSid, ButtonText, ButtonPayload });

    if (!From) {
      logger.warn('Invalid webhook payload:', req.body);
      return;
    }

    // Extract phone number (remove 'whatsapp:' prefix if present)
    const phoneNumber = From.replace('whatsapp:', '').trim();
    
    // Handle interactive template button clicks
    // ButtonText, ButtonPayload, or Body can contain the button identifier
    // Extract button identifier - prioritize ButtonText/ButtonPayload, then try to extract from Body
    let buttonIdentifier = ButtonText || ButtonPayload;
    const messageBody = Body?.trim() || '';
    
    // If no explicit button fields, try to extract button from Body
    // Handle cases like "1", "1.", "You said :1", "0", "15", "30", "45", "60", etc.
    // NOTE: "You said :1" is Twilio's default response when webhook isn't configured
    if (!buttonIdentifier && messageBody) {
      // Try to extract button from "You said :X" pattern (Twilio echo when webhook not configured)
      // Supports both single digits (1-9) and time picker IDs (0, 15, 30, 45, 60)
      const twilioEchoMatch = messageBody.match(/You said\s*:?\s*([1-9]|0|15|30|45|60)/i);
      if (twilioEchoMatch) {
        buttonIdentifier = twilioEchoMatch[1];
        logger.warn(`⚠️ Detected Twilio echo message - webhook may not be configured! Message: "${messageBody}"`);
      } else {
        // Try to extract just the number/button identifier
        // Match single digits (1-9) or time picker IDs (0, 15, 30, 45, 60)
        const buttonMatch = messageBody.match(/(?:^|:|\s)([1-9][\.:]?|0|15|30|45|60)(?:\s|$|\.)/);
        if (buttonMatch) {
          buttonIdentifier = buttonMatch[1].replace(/[\.:]$/, '');
        } else {
          buttonIdentifier = messageBody;
        }
      }
    }

    logger.info(`Processing message from ${phoneNumber}:`, {
      Body: messageBody,
      ButtonText,
      ButtonPayload,
      extractedButton: buttonIdentifier,
      fullBody: req.body
    });

    // Process message asynchronously
    (async () => {
      try {
        // Check if this is a button click from an interactive template
        // CRITICAL: Only treat as button click if we have explicit ButtonText/ButtonPayload
        // OR if Body is EXACTLY a number that indicates a button selection
        // This ensures we ONLY respond to actual button clicks, not regular messages
        const isExplicitButtonClick = !!(ButtonText || ButtonPayload);
        const trimmedBody = messageBody.trim();
        // Check for single digit (1-9) or time picker selections (0, 15, 30, 45, 60)
        const isSimpleNumberClick = trimmedBody && (/^[1-9][\.:]?$/.test(trimmedBody) || /^(0|15|30|45|60)$/.test(trimmedBody));
        // Also detect "You said :1" pattern (Twilio echo when webhook not configured)
        const isTwilioEcho = /You said\s*:?\s*([1-9]|0|15|30|45|60)/i.test(trimmedBody);
        const isButtonClick = isExplicitButtonClick || isSimpleNumberClick || isTwilioEcho;
        
        logger.info(`📥 Message analysis:`, {
          hasButtonText: !!ButtonText,
          hasButtonPayload: !!ButtonPayload,
          body: messageBody,
          isExplicitButton: isExplicitButtonClick,
          isSimpleNumber: isSimpleNumberClick,
          isButtonClick: isButtonClick,
          buttonIdentifier: buttonIdentifier
        });
        
        if (isButtonClick && buttonIdentifier) {
          logger.info(`🔘 Detected button click: "${buttonIdentifier}" (ButtonText: ${ButtonText}, ButtonPayload: ${ButtonPayload}, Body: "${messageBody}")`);
          await messageHandler.handleInteractiveButton(phoneNumber, buttonIdentifier);
        } else {
          // Handle regular message - do NOT send time picker automatically
          logger.info(`💬 Handling as regular message (not a button click): "${messageBody}"`);
          const response = await messageHandler.handleIncomingMessage(phoneNumber, messageBody);
          
          logger.info(`Sending response to ${phoneNumber}: ${response.substring(0, 50)}...`);

          // Send response via Twilio
          await twilioService.sendMessage(phoneNumber, response);
        }
        
        logger.info(`Response sent successfully to ${phoneNumber}`);
      } catch (error) {
        logger.error(`Error processing message from ${phoneNumber}:`, error);
      }
    })();
  } catch (error) {
    logger.error('Error handling webhook:', error);
  }
});

// Twilio status callback endpoint for message delivery status
app.post('/webhook/status', async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
    
    logger.info('Message status update:', {
      MessageSid,
      MessageStatus,
      ErrorCode,
      ErrorMessage,
    });

    // Respond to Twilio
    res.status(200).send('OK');
  } catch (error) {
    logger.error('Error handling status callback:', error);
    res.status(500).send('Internal server error');
  }
});

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  
  // Start reminder scheduler
  reminderScheduler.start();
  
  logger.info('WhatsApp Reminders Bot is ready!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  reminderScheduler.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  reminderScheduler.stop();
  process.exit(0);
});

