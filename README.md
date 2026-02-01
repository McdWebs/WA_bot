# WhatsApp Reminders Bot

A WhatsApp bot for sending automated reminders about Hebrew calendar events (sunset times, candle lighting, prayer times).

## Features

- User registration flow with location-based timezone detection
- Configurable reminder settings for each user
- Automated reminder sending based on user preferences
- Integration with Hebcal API for Hebrew calendar data
- Supabase for data storage
- Twilio WhatsApp API for messaging

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env` file (already provided)

3. Set up Supabase database tables:

Create the following tables in your Supabase project:

**users table:**
```sql
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT UNIQUE NOT NULL,
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  timezone TEXT,
  location TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('active', 'inactive', 'pending')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

**reminder_settings table:**
```sql
CREATE TABLE reminder_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('sunset', 'candle_lighting', 'prayer')),
  enabled BOOLEAN DEFAULT true,
  time_offset_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, reminder_type)
);
```

4. Configure Twilio webhook:
   - In Twilio Console, set the webhook URL to: `https://your-domain.com/webhook/whatsapp`
   - Use POST method

5. (Optional) Dashboard: set `DASHBOARD_API_KEY` in `.env` and build the dashboard:
```bash
cd dashboard && npm install && npm run build && cd ..
```
Then serve the bot; the dashboard is at `http://localhost:3000/dashboard` (log in with your API key).

6. Build and run:
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Usage

Users interact with the bot via WhatsApp:

- Send any message to start registration
- Provide location when prompted
- Use `/menu` to see available commands
- Use `/sunset 30` to set sunset reminder (30 minutes before)
- Use `/candles 15` to set candle lighting reminder (15 minutes before)
- Use `/settings` to view current settings
- Use `/help` for guidance

## Deployment on Render

1. Connect your GitHub repository to Render
2. Create a new Web Service
3. Set build command: `npm install && npm run build`
4. Set start command: `npm start`
5. Add all environment variables from `.env`
6. Deploy!

## Dashboard

An analytics dashboard is available at `/dashboard` (after building it). It shows:

- **Overview**: Total users, active users, reminders, messages sent, Twilio cost; signups over time and reminders by type.
- **Users**: List and detail (profile, reminders, message count).
- **Reminders**: List with filters (type, enabled).
- **Messages**: Message stats from the message log (by day, by type, recent list).
- **Cost**: Twilio usage and cost (today and this month).

Set `DASHBOARD_API_KEY` in your environment and use it to log in. If the frontend is on another origin, set `DASHBOARD_ORIGIN` to that origin for CORS.

## Architecture

- **Twilio**: WhatsApp messaging API
- **MongoDB**: Database for users, reminder preferences, and message log
- **Hebcal API**: Hebrew calendar data (sunset, candle lighting times)
- **Node-cron**: Scheduled reminder checking
- **Express**: Web server for webhooks and dashboard API

## Reminder Types

1. **Sunset Times** - Daily sunset reminders
2. **Candle Lighting** - Shabbat and holiday candle lighting times
3. **Prayer Times** - Daily prayer time reminders (to be implemented)

