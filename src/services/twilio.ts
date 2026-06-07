import twilio from "twilio";
import { config } from "../config";
import logger, { shortPhone } from "../utils/logger";
import { appendMessageLog } from "./messageLog";

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

export class TwilioService {
  async sendMessage(to: string, message: string): Promise<void> {
    try {
      const result = await client.messages.create({
        from: `whatsapp:${config.twilio.whatsappFrom}`,
        to: `whatsapp:${to}`,
        body: message,
      });

      logger.debug(`→ ${shortPhone(to)} text ${result.sid}`);
      appendMessageLog({
        phone_number: to,
        twilio_sid: result.sid,
        type: "freeform",
        sent_at: new Date().toISOString(),
      }).catch(() => {});
    } catch (error) {
      logger.error(`Send text failed → ${shortPhone(to)}`, error);
      throw error;
    }
  }

  async sendTemplateMessage(
    to: string,
    templateKey:
      | "welcome"
      | "complete"
      | "genderQuestion"
      | "mainMenu"
      | "womanMenu"
      | "tefillinTimePicker"
      | "cityPicker"
      | "shemaTimePicker"
      | "reminderList"
      | "city_picker"
      | "candleLightingTimePicker"
      | "candleLightingTimePickerWomen"
      | "shemaFinalMessage"
      | "tefilinFinalMessage"
      | "candleLightingFinalMessage"
      | "candleLightingFinalMessageWomen"
      | "taaraTimePicker"
      | "taaraFinalMessage"
      | "clean7FinalMessage"
      | "clean7StartTaaraTime"
      | "broadcast",
    parameters?: Record<string, string>
  ): Promise<{ sid: string; status: string }> {
    const templateSid = config.templates[templateKey];

    try {
      if (!templateSid || templateSid.trim() === "") {
        throw new Error(
          `Template ${templateKey} not configured (SID is empty or missing)`
        );
      }

      const messagePayload: any = {
        from: `whatsapp:${config.twilio.whatsappFrom}`,
        to: `whatsapp:${to}`,
        contentSid: templateSid,
      };

      if (parameters && Object.keys(parameters).length > 0) {
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

      const started = Date.now();
      const result = await client.messages.create(messagePayload);

      if (result.errorCode) {
        const templateError: any = new Error(
          `Twilio error ${result.errorCode}: ${result.errorMessage}`
        );
        templateError.code = result.errorCode;
        templateError.isTemplateError = true;
        throw templateError;
      }

      if (result.status === "failed" || result.status === "undelivered") {
        const statusError: any = new Error(
          `Message failed with status: ${result.status}`
        );
        statusError.isTemplateError = true;
        throw statusError;
      }

      logger.debug(
        `→ ${shortPhone(to)} ${templateKey} ${result.sid} (${Date.now() - started}ms)`
      );

      appendMessageLog({
        phone_number: to,
        twilio_sid: result.sid,
        type: "template",
        template_key: templateKey,
        sent_at: new Date().toISOString(),
        status: result.status,
      }).catch(() => {});

      return { sid: result.sid, status: result.status };
    } catch (error: any) {
      logger.error(
        `Send template failed → ${shortPhone(to)} key=${templateKey} code=${error?.code ?? "n/a"}: ${error?.message ?? error}`
      );
      if (error.code === 63027 || error.isTemplateError) {
        error.isTemplateError = true;
      }
      throw error;
    }
  }

  async fetchMessageStatus(sid: string): Promise<string> {
    const message = await client.messages(sid).fetch();
    return message.status ?? "unknown";
  }

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
      logger.error("Webhook signature validation failed:", error);
      return false;
    }
  }
}

export default new TwilioService();
