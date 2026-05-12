# WA Reminder Bot - Claude Context Pack

This document is a low-token, high-signal map of the codebase so an LLM can add features quickly without re-scanning everything.

## 1) What this project is

- A Node.js + TypeScript WhatsApp bot using Twilio webhooks.
- Core domain: Hebrew-time reminders (tefillin, shema, candle lighting) plus women flows (`taara`, `clean_7`).
- Storage: MongoDB (`users`, `reminder_preferences`, `message_log`).
- Scheduler: `node-cron` every minute checks active reminders and sends templates.
- Includes a protected analytics dashboard (`/dashboard`) with backend API (`/api/dashboard/*`) and React frontend in `dashboard/`.

## 2) Runtime architecture

- Entrypoint: `src/index.ts`
  - Configures Express, webhook routes, health routes, dashboard routes/static hosting, CORS.
  - Starts scheduler and attempts background Mongo connection.
- Incoming WhatsApp flow:
  - `POST /webhook/whatsapp` immediately ACKs Twilio (`200 ""`) then processes async in background.
  - `processWhatsAppMessage()` classifies message as interactive button, text, or shared location.
  - Delegates to `messageHandler` methods.
- Message handler facade:
  - `src/bot/messageHandler.ts` orchestrates:
    - `incomingMessageFlow` (text)
    - `interactiveButtonFlow` (button/list payload)
    - `incomingLocationFlow` (lat/lng pin)
- Scheduler:
  - `src/schedulers/reminderScheduler.ts`
  - Every minute: fetch active reminders + users, compute should-send, send templates, update `last_sent_at`.

## 3) Key modules and responsibilities

- `src/config/index.ts`
  - Loads env via `dotenv`.
  - Holds Twilio creds, template SIDs, test mode, dashboard auth/CORS.
- `src/services/twilio.ts`
  - `sendMessage()` for freeform text.
  - `sendTemplateMessage()` for Twilio Content template SIDs + numbered variables.
  - Logs every outbound message to `message_log`.
- `src/services/mongo.ts`
  - Singleton DB connection with retry/reset on connection errors.
  - All CRUD for users/reminders/stats.
- `src/services/hebcal.ts`
  - Hebcal + Zmanim API adapter, with caching and fallbacks.
  - Supports city and geo coords (`geo:lat,lng`) location formats.
- `src/services/reminderService.ts`
  - Text-based reminder management flow: list/select/edit/delete.
- `src/services/reminderStateManager.ts`
  - In-memory state machine for reminder management per phone.
- `src/services/settingsStateManager.ts`
  - In-memory state for text settings menu flow.
- `src/routes/dashboard.ts`
  - API-key-protected dashboard endpoints for stats/users/reminders/messages/usage.

## 4) Data model (Mongo collections)

## `users`

- Fields:
  - `phone_number` (primary lookup key)
  - `status` (`active`/`inactive`/`pending`)
  - `gender` (`male`/`female`/`prefer_not_to_say`)
  - `location` (city string OR `geo:lat,lng`)
  - `timezone`
  - `created_at`, `updated_at`
  - optional `id` plus Mongo `_id` (code handles both)

## `reminder_preferences`

- Core fields:
  - `user_id`
  - `reminder_type`: `tefillin`, `candle_lighting`, `shema`, `taara`, `clean_7`
  - `enabled`
  - `time_offset_minutes` (negative=before, positive=after; for some flows used as minutes-from-midnight)
  - `last_sent_at` (duplicate prevention)
- Special fields:
  - `test_time` (`HH:MM`) mostly for test mode and women flows
  - `clean_7_start_date` (`YYYY-MM-DD`, Israel TZ)

## `message_log`

- Outbound log for dashboard analytics:
  - `phone_number`, `twilio_sid`, `type` (`template`/`freeform`), `template_key`, `sent_at`, status/error fields.

## 5) Conversation and state machine map

There are two layers of state:

- `MessageHandlerMutableState` (in `src/bot/messageHandler/state.ts`)
  - `creatingReminderType`
  - `lastCityPickerContext`
  - `awaitingCustomLocation`
  - `femaleFlowMode`
- Service state managers:
  - `ReminderStateManager` modes:
    - `CHOOSE_REMINDER` -> `REMINDER_ACTION` -> (`EDIT_REMINDER` or `CONFIRMING_DELETE`)
  - `SettingsStateManager` modes:
    - `MAIN_MENU` -> `CHANGE_GENDER`

Important: these states are in-memory only (lost on process restart).

## 6) Main user journeys

## New user

1. First text arrives at webhook.
2. User is auto-created in Mongo if missing.
3. Bot sends `welcome` template, waits 3s, sends `genderQuestion` template.
4. On gender button, user updated and main menu template sent.

## Existing user, normal conversation start

1. Text processed by `incomingMessageFlow`.
2. If no active state flow and not command-like text, bot sends `welcome`.
3. If no gender -> asks gender, else sends main menu + text settings menu.

## Reminder creation

1. User chooses reminder type (button or matching Hebrew text).
2. If saved location exists, skip city picker; else send city picker.
3. Optional custom location path:
  - user selects custom location option then shares pin.
  - location stored as `geo:lat,lng`.
4. Bot sends relevant time picker / flow-specific step.
5. Save reminder (`upsertReminderSetting`) and send completion/final template.

## Reminder management (edit/delete)

1. User asks to show reminders (`הצג תזכורות` or button).
2. `ReminderService.listReminders()` sends numbered list and sets `CHOOSE_REMINDER`.
3. User picks reminder number -> `REMINDER_ACTION`.
4. Edit -> send time picker and update offset.
5. Delete -> confirm (`כן/לא`) then delete.

## Women flows

- `taara` (hefsek tahara):
  - select flow, choose city/time, save `taara` reminder.
  - scheduler disables it after first send (one-time behavior).
- `clean_7`:
  - saves start date, sends daily at 09:00 for day 1..7.
  - scheduler auto-disables after completion window.
- combined path `taara_plus_clean7` supported.

## 7) Scheduling logic

File: `src/schedulers/reminderScheduler.ts`

- Runs every minute.
- Skips all checks on Saturday (Shabbat) in Israel timezone.
- Fetches all enabled reminder settings joined with active users.
- For each reminder type:
  - `tefillin`: relative to sunset.
  - `shema`: relative to shema time.
  - `candle_lighting`:
    - only Friday
    - supports 08:00 option (`time_offset_minutes=0`) or -60/-120 relative to candle lighting.
  - `taara`: chosen daily time (stored in `test_time`/offset) but disabled after first send.
  - `clean_7`: daily 09:00, day 1-7 from `clean_7_start_date`.
- Duplicate prevention uses `last_sent_at` compared with Israel date.

## 8) External integrations

- Twilio WhatsApp API
  - Incoming webhook: `/webhook/whatsapp`
  - Status callback: `/webhook/status`
  - Uses Content Template SIDs from env.
- Hebcal APIs
  - Calendar API + Zmanim API.
  - Zmanim is preferred for accurate times.
  - Fallbacks and approximations exist for resilience.
- MongoDB
  - Singleton connection and retry/reconnect logic.

## 9) Dashboard architecture

- Backend route mount: `/api/dashboard` in `src/index.ts`.
- Auth: bearer or `x-api-key` must match `DASHBOARD_API_KEY`.
- Main endpoints in `src/routes/dashboard.ts`:
  - `/stats`
  - `/users`, `/users/:id`
  - `/reminders`, `/reminders/:id`, `PATCH /reminders/:id`
  - `/messages`
  - `/usage`
- Frontend (`dashboard/`):
  - React + Vite + React Query + React Router.
  - token in `sessionStorage` key `dashboard_api_key`.
  - API helper in `dashboard/src/api.ts`.

## 10) Environment variables (high impact)

- Core:
  - `PORT`, `NODE_ENV`, `MONGODB_URI`
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
- Templates:
  - `WHATSAPP_TEMPLATE_WELCOME`
  - `GENDER_QUESTION_MENU` (or legacy fallback key)
  - menus/time pickers/final message template keys in `config.templates`
- Bot behavior:
  - `DEFAULT_TIMEZONE`, `LOG_LEVEL`, `WEBHOOK_URL`
  - `ENABLE_TEST_REMINDERS`, `TEST_REMINDER_WINDOW_MINUTES`
- Dashboard:
  - `DASHBOARD_API_KEY`
  - `DASHBOARD_ORIGIN` (CORS when frontend hosted elsewhere)

## 11) Where to implement common feature types

## A) Add a new reminder type

1. Add type to `src/types/index.ts` (`ReminderType` union).
2. Add labels in:
  - `reminderService.formatReminderTypeHebrew()`
  - any UI menus/templates that expose this reminder.
3. Add button/text recognition in:
  - `interactiveButtonFlow.ts`
  - `incomingMessageFlow.ts`
4. Add picker/collection logic in:
  - `pickers.ts`
  - `persistence.ts`
5. Add scheduling logic in:
  - `reminderScheduler.shouldSendReminder()`
  - `reminderScheduler.sendReminder()`
6. Add dashboard filter support (if needed):
  - backend route accepts type already, dashboard UI type dropdown may need update.

## B) Add/adjust a button flow

- Primary router for interactive payloads: `interactiveButtonFlow.ts`.
- Keep payload normalization robust (`normalizedButton`, `cleanButton`).
- If flow requires multi-step text input after button, use state managers.

## C) Add a text command/intent

- Entry: `incomingMessageFlow.ts`.
- For slash commands only: `commands.ts`.
- Keep fallback behavior unchanged (`return ""`) when no explicit response is needed.

## D) Add dashboard metric

1. Add backend aggregate endpoint or extend existing endpoint in `dashboard.ts`/`mongo.ts`.
2. Add typed interface in `dashboard/src/api.ts`.
3. Add query + rendering in target dashboard page.

## 12) Gotchas and implementation rules

- Twilio webhook ACK must stay immediate and non-blocking.
- Do not block webhook request waiting for DB/Twilio operations.
- Many flows rely on in-memory state; restarting process interrupts active conversation state.
- `location` can be either city name or `geo:lat,lng`; new code must handle both.
- Preserve `last_sent_at` update logic to avoid duplicate sends.
- Some template keys have legacy/misspelled env names; verify in `src/config/index.ts`.
- If a template is missing, fallback text paths exist; keep them robust.
- Scheduler uses Israel date/day-of-week for critical checks.

## 13) Suggested engineering improvements (if asked)

- Persist conversation state in Mongo/Redis (avoid restart state loss).
- Add centralized payload constants for button IDs to reduce string drift.
- Add tests around scheduler edge cases (timezone boundaries, Friday logic, day transitions).
- Add schema validation for webhook payload and dashboard PATCH body.
- Normalize/validate reminder offsets per reminder type.

## 14) Fast file index

- Server bootstrap + webhooks: `src/index.ts`
- Message orchestration: `src/bot/messageHandler.ts`
- Text flow: `src/bot/messageHandler/incomingMessageFlow.ts`
- Interactive flow: `src/bot/messageHandler/interactiveButtonFlow.ts`
- Location flow: `src/bot/messageHandler/incomingLocationFlow.ts`
- Pickers: `src/bot/messageHandler/pickers.ts`
- Reminder save/update helpers: `src/bot/messageHandler/persistence.ts`
- Scheduler: `src/schedulers/reminderScheduler.ts`
- Mongo service: `src/services/mongo.ts`
- Reminder service: `src/services/reminderService.ts`
- Twilio service: `src/services/twilio.ts`
- Hebcal/Zmanim service: `src/services/hebcal.ts`
- Dashboard API: `src/routes/dashboard.ts`
- Dashboard frontend API client: `dashboard/src/api.ts`

---

If Claude receives this file first, it should be able to propose and implement most new bot features with minimal additional repo scanning.
