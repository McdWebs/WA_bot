# Bot Dashboard

React + Vite analytics dashboard for the WhatsApp Reminders Bot.

## Development

```bash
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend (default http://localhost:3000). Log in with your `DASHBOARD_API_KEY`.

## Production

Build and serve from the main app:

```bash
npm run build
```

Then run the bot from the repo root; the dashboard is at `http://localhost:3000/dashboard` (or your deployed URL + `/dashboard`). Log in with `DASHBOARD_API_KEY`.

## Environment

- Backend must have `DASHBOARD_API_KEY` set (used as the shared secret for dashboard API auth).
- Optional: `DASHBOARD_ORIGIN` on the backend when the frontend is on another host (CORS).
