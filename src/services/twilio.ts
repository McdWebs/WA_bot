import twilio from 'twilio';
import { config } from '../config';
import logger from '../utils/logger';

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
    templateKey: 'welcome' | 'timePicker' | 'complete',
    parameters?: Record<string, string>
  ): Promise<void> {
    try {
      const templateSid = config.templates[templateKey];
      
      if (!templateSid) {
        throw new Error(`Template ${templateKey} not configured`);
      }

      // For WhatsApp templates, use contentSid with contentVariables
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
        const isNumbered = Object.keys(parameters).every(key => /^\d+$/.test(key));
        const numberedVariables = isNumbered 
          ? parameters 
          : Object.values(parameters).reduce((acc, value, index) => {
              acc[String(index + 1)] = value;
              return acc;
            }, {} as Record<string, string>);
        
        messagePayload.contentVariables = JSON.stringify(numberedVariables);
      }

      const result = await client.messages.create(messagePayload);

      logger.info(`Template message sent to ${to}: ${result.sid}`);
    } catch (error) {
      logger.error(`Error sending template message to ${to}:`, error);
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
      logger.error('Error validating webhook signature:', error);
      return false;
    }
  }
}

export default new TwilioService();

