# Bot Dashboard

React + Vite analytics dashboard for the WhatsApp Reminders Bot.

## Using the public backend (Render)

Backend URL: **https://wa-bot-7ppq.onrender.com**

**Option A – Dashboard served from the same backend**  
If you deploy the bot (with dashboard build) to Render, the dashboard is at `https://wa-bot-7ppq.onrender.com/dashboard`. No extra env: API calls use the same origin.

**Option B – Dashboard on another host or local dev**  
To point the dashboard at the Render backend:

1. In the dashboard folder, create `.env` (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```
   `.env.example` already sets `VITE_API_BASE_URL=https://wa-bot-7ppq.onrender.com`.

2. Build the dashboard:
   ```bash
   npm run build
   ```

3. On the **backend** (Render), set **DASHBOARD_ORIGIN** to the dashboard origin (so CORS allows it):
   - Local dev: `DASHBOARD_ORIGIN=http://localhost:5173`
   - Deployed elsewhere: `DASHBOARD_ORIGIN=https://your-dashboard-domain.com`

Then open the dashboard (locally or your host) and log in with `DASHBOARD_API_KEY`.

## Development

```bash
npm install
npm run dev
```

By default the dev server proxies `/api` to `http://localhost:3000`. To use the Render backend instead, add to `.env`:

```env
VITE_API_BASE_URL=https://wa-bot-7ppq.onrender.com
```

and on Render set `DASHBOARD_ORIGIN=http://localhost:5173`. Restart `npm run dev` after changing `.env`.

## Production (same server)

Build and serve from the main app:

```bash
npm run build
```

Run the bot from the repo root; the dashboard is at `https://wa-bot-7ppq.onrender.com/dashboard`. Log in with `DASHBOARD_API_KEY`.

## Environment

- **Backend:** `DASHBOARD_API_KEY` (required for dashboard auth).
- **Backend:** `DASHBOARD_ORIGIN` – set when the dashboard is on another origin (for CORS).
- **Dashboard:** `VITE_API_BASE_URL` – set to `https://wa-bot-7ppq.onrender.com` when the dashboard is not served from the same backend.
