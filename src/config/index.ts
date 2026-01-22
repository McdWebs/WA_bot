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
    timePicker: process.env.WHATSAPP_TEMPLATE_TIME_PICKER!,
    complete: process.env.WHATSAPP_TEMPLATE_COMPLETE!,
    genderQuestion: process.env.WHATSAPP_TEMPLATE_GENDER_QUESTION_V3 || "",
    mainMenu: process.env.WHATSAPP_TEMPLATE_MENU || "",
    tefillinTimePicker:
      process.env.WHATSAPP_TEMPLATE_TEFILIN_TIME_PICKER || "",
    cityPicker: process.env.WHATSAPP_TEMPLATE_CITY_PICKER || "",
    shemaTimePicker: process.env.WHATSAPP_TEMPLATE_SHEMA_TIME_PICKER_V2 || "",
    reminderList: process.env.WHATSAPP_TEMPLATE_REMINDER_LIST || "",
    manageReminders: process.env.WHATSAPP_TEMPLATE_MANAGE_REMINDERS || "",
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
