---
name: WhatsApp Reminders Bot Implementation Plan
overview: ""
todos:
  - id: c475479f-0df6-4185-8a6f-ea6d395318c9
    content: Initialize Node.js/TypeScript project with package.json, tsconfig.json, and folder structure
    status: pending
  - id: a040b623-ffd1-4513-8e63-b146e5b5b82b
    content: Set up WhatsApp Web.js client with QR code authentication and message handlers
    status: pending
  - id: 6b7c8984-dc2e-4883-bd8b-63871ab61782
    content: Implement Google Sheets service with OAuth 2.0 authentication and CRUD operations
    status: pending
  - id: b503558b-5968-4f47-adae-b8c3b9bb621f
    content: Create Hebcal API integration service for fetching Hebrew calendar data (sunset, candle lighting, prayer times)
    status: pending
  - id: b16b2e5e-bcde-4c84-82ae-a31ddbcc9cf2
    content: Implement user registration flow with location collection and timezone detection
    status: pending
  - id: fd3ea6a7-c3a4-45d8-904e-7fb5e4dc3545
    content: Build settings command handlers for users to configure reminder times for each type
    status: pending
  - id: f2d32500-b474-48d9-85f7-fdaf7e0ad6f9
    content: Create bot menu system with reminder type selection and help commands
    status: pending
  - id: 9ec62085-9c55-4040-a88d-21415ca1fedc
    content: Implement pre-approved message template system with dynamic data placeholders
    status: pending
  - id: b4e1e012-8abc-42a0-ad7c-b051f5b86e45
    content: Build reminder scheduler that loads user settings, checks Hebcal data, and sends WhatsApp messages at scheduled times
    status: pending
  - id: 004ddeb7-9a6a-4ff3-abf6-1e4f530fcee1
    content: Create timezone detection and conversion utilities for handling user locations
    status: pending
  - id: 9f08afd5-e62b-4270-9684-3528b83d7437
    content: Configure Render deployment settings, environment variables, and health check endpoint
    status: pending
---

# WhatsApp Reminders Bot Implementation Plan

## Architecture Overview

A Node.js/TypeScript WhatsApp bot using Twilio WhatsApp API for messaging, integrated with Supabase for data storage, Hebcal API for Hebrew calendar data, and scheduled jobs for sending reminders. Deployed on Render.

## Core Components

### 1. Project Structure

- `src/` - Main source code
- `bot/` - WhatsApp bot handlers
- `services/` - External service integrations (Google Sheets, Hebcal)
- `schedulers/` - Reminder scheduling logic
- `utils/` - Helper functions (timezone detection, time parsing)
- `types/` - TypeScript type definitions
- `config/` - Configuration files
- `.env` - Environment variables

### 2. Key Files to Create

**`src/bot/whatsapp.ts`** - WhatsApp client initialization and message handlers

- Initialize WhatsApp Web client
- Handle incoming messages
- Route commands to appropriate handlers

**`src/bot/commands/registration.ts`** - User registration flow

- Welcome new users
- Collect user information (phone number, location for timezone)
- Store in Google Sheets

**`src/bot/commands/settings.ts`** - User settings management

- Allow users to set reminder times for each reminder type
- Update settings in Google Sheets
- Validate time inputs

**`src/bot/commands/menu.ts`** - Bot menu and navigation

- Display available reminder types (sunset, candle lighting, prayer times)
- Help/guidance commands
- Template approval interface

**`src/services/googleSheets.ts`** - Google Sheets integration

- OAuth 2.0 authentication flow
- CRUD operations for user data
- User settings storage
- Reminder preferences storage

**`src/services/hebcal.ts`** - Hebcal API integration

- Fetch sunset times
- Fetch candle lighting times (Shabbat/Holidays)
- Fetch prayer times
- Cache results appropriately

**`src/schedulers/reminderScheduler.ts`** - Reminder scheduling system

- Load all user reminders from Google Sheets
- Schedule reminder jobs based on user settings
- Handle timezone conversions
- Send reminders via WhatsApp

**`src/utils/timezone.ts`** - Timezone utilities

- Auto-detect timezone from user location
- Convert times between timezones
- Handle Hebrew calendar date conversions

**`src/utils/messageTemplates.ts`** - Pre-approved message templates

- Template storage and retrieval
- Template formatting with dynamic data

**`src/index.ts`** - Main entry point

- Initialize services
- Start WhatsApp bot
- Start reminder scheduler
- Handle graceful shutdown

### 3. Google Sheets Structure

**Users Sheet:**

- Phone number (unique identifier)
- Registration date
- Timezone
- Location (city/country)
- Status (active/inactive)

**Settings Sheet:**

- Phone number (foreign key)
- Reminder type (sunset/candle_lighting/prayer)
- Enabled (boolean)
- Time offset (minutes before/after event)
- Last updated

**Reminder Log Sheet (optional):**

- Phone number
- Reminder type
- Sent timestamp
- Message content

### 4. Dependencies

- `whatsapp-web.js` - WhatsApp Web API client
- `qrcode-terminal` - QR code display for WhatsApp authentication
- `googleapis` - Google Sheets API client
- `node-cron` or `node-schedule` - Job scheduling
- `axios` - HTTP requests for Hebcal API
- `dotenv` - Environment variable management
- `typescript` - TypeScript compiler
- `ts-node` - TypeScript execution

### 5. Environment Variables

- `GOOGLE_CLIENT_ID` - OAuth 2.0 client ID
- `GOOGLE_CLIENT_SECRET` - OAuth 2.0 client secret
- `GOOGLE_REDIRECT_URI` - OAuth redirect URI
- `GOOGLE_REFRESH_TOKEN` - OAuth refresh token
- `GOOGLE_SPREADSHEET_ID` - Google Sheets spreadsheet ID
- `HEBCAL_API_KEY` (if required)
- `PORT` - Server port (for Render)

### 6. Implementation Flow

1. **Registration Flow:**

- User sends initial message → Bot responds with welcome
- Bot asks for location → User provides city/country
- Bot detects timezone → Stores user in Google Sheets
- Bot shows menu with reminder types

2. **Settings Flow:**

- User selects reminder type from menu
- Bot asks for time preference (e.g., "30 minutes before sunset")
- Bot validates and stores in Google Sheets
- Bot confirms setting saved

3. **Reminder Sending:**

- Scheduler runs periodically (every minute or 5 minutes)
- Fetches all active users and their settings from Google Sheets
- For each user, checks if any reminder should be sent now
- Fetches current day's data from Hebcal API
- Sends WhatsApp message using pre-approved template

4. **Template Approval:**

- Pre-defined templates stored in code/config
- Users can view templates via menu command
- Templates include placeholders for dynamic data (time, date, etc.)

### 7. Render Deployment

- Use Node.js buildpack
- Set environment variables in Render dashboard
- Configure health check endpoint
- Set up persistent storage for WhatsApp session (if needed)

### 8. Error Handling & Edge Cases

- Handle WhatsApp disconnections/reconnections
- Handle Google Sheets API rate limits
- Handle Hebcal API failures (fallback/caching)
- Handle invalid user inputs gracefully
- Handle timezone detection failures
- Handle users who haven't completed registration

## Technical Considerations

- WhatsApp Web.js requires QR code scanning for initial authentication
- Google Sheets OAuth 2.0 requires initial authorization flow (one-time setup)
- Hebcal API may have rate limits - implement caching
- Timezone detection from location may require geocoding API (Google Maps or similar)
- Scheduler needs to handle timezone conversions correctly
- WhatsApp session persistence for Render deployment