import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
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
  },
  
  hebcal: {
    apiBaseUrl: process.env.HEBCAL_API_BASE_URL || 'https://www.hebcal.com/hebcal',
  },
  
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'Asia/Jerusalem',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Validate required environment variables
const requiredVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

