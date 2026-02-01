import twilio from "twilio";
import { config } from "../config";
import logger from "../utils/logger";
import { appendMessageLog } from "./messageLog";

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

export class TwilioService {
  /**
   * Sends a WhatsApp message using Twilio
   */
  async sendMessage(to: string, message: string): Promise<void> {
    try {
      const result = await client.messages.create({
        from: `whatsapp:${config.twilio.whatsappFrom}`,
        to: `whatsapp:${to}`,
        body: message,
      });

      logger.info(`Message sent to ${to}: ${result.sid}`);
      appendMessageLog({
        phone_number: to,
        twilio_sid: result.sid,
        type: "freeform",
        sent_at: new Date().toISOString(),
      }).catch(() => {});
    } catch (error) {
      logger.error(`Error sending message to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Sends a WhatsApp message using a template
   */
  async sendTemplateMessage(
    to: string,
    templateKey:
      | "welcome"
      | "complete"
      | "genderQuestion"
      | "mainMenu"
      | "tefillinTimePicker"
      | "cityPicker"
      | "shemaTimePicker"
      | "reminderList"
      | "manageReminders"
      | "city_picker"
      | "candleLightingTimePicker",
    parameters?: Record<string, string>
  ): Promise<void> {
    const templateSid = config.templates[templateKey];

    try {
      if (!templateSid || templateSid.trim() === "") {
        logger.error(`Template ${templateKey} not configured, cannot send template`);
        logger.error(`Template key: ${templateKey}, SID: ${templateSid || "NOT SET"}`);
        logger.error(`Environment variable check: WHATSAPP_TEMPLATE_CANDLE_LIGHTING_TIME_PICKER = ${process.env.WHATSAPP_TEMPLATE_CANDLE_LIGHTING_TIME_PICKER || "NOT SET"}`);
        const error = new Error(
          `Template ${templateKey} not configured (SID is empty or missing)`
        );
        throw error;
      }

      // For WhatsApp templates, use contentSid with contentVariables
      // Note: Language/locale is embedded in the Content Template itself
      // Error 63027 usually means the template's language doesn't match WhatsApp's expected locale
      const messagePayload: any = {
        from: `whatsapp:${config.twilio.whatsappFrom}`,
        to: `whatsapp:${to}`,
        contentSid: templateSid,
      };

      // Add contentVariables if parameters are provided
      if (parameters && Object.keys(parameters).length > 0) {
        // Twilio Content API expects contentVariables as a JSON string
        // Variables must be numbered sequentially (1, 2, 3, etc.)
        // If parameters are already numbered (string keys "1", "2", etc.), use as-is
        // Otherwise, convert named parameters to numbered format
        const isNumbered = Object.keys(parameters).every((key) =>
          /^\d+$/.test(key)
        );
        const numberedVariables = isNumbered
          ? parameters
          : Object.values(parameters).reduce((acc, value, index) => {
              acc[String(index + 1)] = value;
              return acc;
            }, {} as Record<string, string>);

        messagePayload.contentVariables = JSON.stringify(numberedVariables);
      }

      const templateSendStart = Date.now();
      logger.info(
        `📤 Sending template ${templateKey} (SID: ${templateSid}) to ${to} at ${new Date(templateSendStart).toISOString()}`
      );

      const result = await client.messages.create(messagePayload);

      const templateSendEnd = Date.now();
      const templateSendLatency = templateSendEnd - templateSendStart;
      
      logger.info(
        `✅ Template sent to ${to} in ${templateSendLatency}ms: ${result.sid}, status: ${result.status} at ${new Date(templateSendEnd).toISOString()}`
      );

      // Check for ANY error code, not just 63027
      if (result.errorCode) {
        logger.error(
          `Message error code: ${result.errorCode}, message: ${result.errorMessage}`
        );
        const templateError: any = new Error(
          `Twilio error ${result.errorCode}: ${result.errorMessage}`
        );
        templateError.code = result.errorCode;
        templateError.isTemplateError = true;
        throw templateError;
      }

      // Verify message status indicates success
      if (result.status === 'failed' || result.status === 'undelivered') {
        logger.error(`Message status indicates failure: ${result.status}`);
        const statusError: any = new Error(
          `Message failed with status: ${result.status}`
        );
        statusError.isTemplateError = true;
        throw statusError;
      }

      appendMessageLog({
        phone_number: to,
        twilio_sid: result.sid,
        type: "template",
        template_key: templateKey,
        sent_at: new Date().toISOString(),
      }).catch(() => {});
    } catch (error: any) {
      logger.error(`Error sending template message to ${to}:`, error);
      logger.error(
        `Template key: ${templateKey}, SID: ${templateSid || "NOT SET"}`
      );
      if (error.code) {
        logger.error(`Twilio error code: ${error.code}`);
      }
      if (error.message) {
        logger.error(`Error message: ${error.message}`);
      }
      if (error.moreInfo) {
        logger.error(`More info: ${error.moreInfo}`);
      }
      // Mark 63027 errors so they can be handled gracefully
      if (error.code === 63027 || error.isTemplateError) {
        error.isTemplateError = true;
      }
      throw error;
    }
  }

  /**
   * Validates webhook signature
   */
  validateWebhookSignature(
    url: string,
    params: Record<string, string>,
    signature: string
  ): boolean {
    try {
      return twilio.validateRequest(
        config.twilio.authToken,
        signature,
        url,
        params
      );
    } catch (error) {
      logger.error("Error validating webhook signature:", error);
      return false;
    }
  }
}

export default new TwilioService();
