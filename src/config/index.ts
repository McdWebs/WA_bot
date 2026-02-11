import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  /**
   * @deprecated Supabase configuration is deprecated in favor of MongoDB (MONGODB_URI).
   * This is kept for backward compatibility and should not be used in new code.
   */
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
    authToken: process.env.TWILIO_AUTH_TOKEN!,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM!,
    webhookSecret: process.env.TWILIO_WEBHOOK_SECRET!,
  },

  templates: {
    welcome: process.env.WHATSAPP_TEMPLATE_WELCOME!,
    complete: process.env.WHATSAPP_TEMPLATE_COMPLETE || "",
    // Gender selection question (new template name takes precedence if set)
    genderQuestion:
      process.env.GENDER_QUESTION_MENU ||
      process.env.WHATSAPP_TEMPLATE_GENDER_QUESTION_V3 ||
      "",
    // Main menus
    mainMenu: process.env.WHATSAPP_TEMPLATE_MENU || "",
    womanMenu: process.env.WOMEAN_MENU || "",
    tefillinTimePicker: process.env.WHATSAPP_TEMPLATE_TEFILIN_TIME_PICKER || "",
    cityPicker: process.env.WHATSAPP_TEMPLATE_CITY_PICKER || "",
    shemaTimePicker: process.env.WHATSAPP_TEMPLATE_SHEMA_TIME_PICKER_V2 || "",
    reminderList: process.env.WHATSAPP_TEMPLATE_REMINDER_LIST || "",
    manageReminders: process.env.WHATSAPP_TEMPLATE_MANAGE_REMINDERS || "",
    city_picker: process.env.CITY_PICKER || "",
    candleLightingTimePicker: process.env.WHATSAPP_TEMPLATE_CANDLE_LIGHTING_TIME_PICKER || "",
    candleLightingTimePickerWomen: process.env.WHATSAPP_TEMPLATE_CANDLE_LIGHTING_TIME_PICKER_WOMEN || "",
    candleLightingFinalMessageWomen: process.env.WHATSAPP_TEMPLATE_CANDLE_LIGHTING_final_message_WOMEN || "",
    // Women's flows – tahara / 7 clean days
    taaraTimePicker: process.env.TAARA_TIME_CHOSE_REMAINDER_TIME || "",
    taaraFinalMessage: process.env.TAARA_TIME_FINAL_MESSAGE || "",
    clean7FinalMessage: process.env.CLEAN_7_FINAL_MESSAGE || "",
    clean7StartTaaraTime: process.env.CLEAN_7_START_TAARA_TIME || "",
    // Final reminder messages (used to avoid WhatsApp 24-hour freeform limits)
    shemaFinalMessage: process.env.WHATSAPP_TEMPLATE_SHEMA_final_message || "",
    tefilinFinalMessage: process.env.WHATSAPP_TEMPLATE_TEFILIN_final_message || "",
    candleLightingFinalMessage:
      process.env.WHATSAPP_TEMPLATE_CANDLE_LIGHTING_final_message || "",
    candleLightingFinalMessageWomen:
      process.env.WHATSAPP_TEMPLATE_CANDLE_LIGHTING_final_message_WOMEN || "",
  },

  hebcal: {
    apiBaseUrl:
      process.env.HEBCAL_API_BASE_URL || "https://www.hebcal.com/hebcal",
  },

  defaultTimezone: process.env.DEFAULT_TIMEZONE || "Asia/Jerusalem",
  logLevel: process.env.LOG_LEVEL || "info",
  webhookUrl: process.env.WEBHOOK_URL || "",

  // TEST MODE: Enable test reminders based on current time (NOT FOR PRODUCTION)
  testMode: {
    enabled: process.env.ENABLE_TEST_REMINDERS === "true",
    // In test mode, trigger reminder if current time is within this many minutes of reminder time
    triggerWindowMinutes: parseInt(process.env.TEST_REMINDER_WINDOW_MINUTES || "5", 10),
  },

  // Dashboard API: optional in dev, required in production when dashboard is used
  dashboard: {
    apiKey: process.env.DASHBOARD_API_KEY || "",
    // When set, CORS allows this origin for /api/dashboard (e.g. when frontend is on another host)
    origin: process.env.DASHBOARD_ORIGIN || "",
  },
};

// Validate required environment variables
const requiredVars = [
  // Supabase vars are deprecated but kept optional for now, so we don't enforce them
  // "SUPABASE_URL",
  // "SUPABASE_ANON_KEY",
  // "SUPABASE_SERVICE_ROLE_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "MONGODB_URI",
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}
