# Cursor Agent Prompt: Tefillin Stations Finder (Hidabroot)

## Context

Read `CLAUDE_CONTEXT.md` first for architecture. This is a Node.js + TypeScript WhatsApp bot (Twilio webhooks, MongoDB, Express). Do not break existing reminder flows.

**Feature:** Add a **Tefillin Stations finder** — users share their location and get the nearest Hidabroot (הדברות) tefillin stations.

---

## User flow (must match exactly)

1. User taps **"📍 עמדות תפילין"** from the main menu (available for all genders — not tied to the tefillin *reminder* flow).
2. Bot asks the user to share their current location (WhatsApp pin: 📎 → Location).
3. User shares location (lat/lng on webhook).
4. Bot replies with **5–10 nearest stations**, each showing:
   - Station name
   - Full address
   - Distance in km (1 decimal place, e.g. `2.3 ק"מ`)
5. After results, offer a simple way back to the main menu (button or Hebrew text like `חזרה` / existing back pattern).

---

## Technical scope

### 1. MongoDB collection: `tefillin_stations`

Schema (adjust naming to match existing conventions in `src/types/index.ts`):

```ts
{
  name: string;           // station name
  address: string;        // full address
  latitude: number;
  longitude: number;
  source?: string;        // e.g. "hidabroot"
  created_at: Date;
  updated_at: Date;
}
```

- Add a **2dsphere index** on `{ latitude, longitude }` (or a GeoJSON `location` field if you prefer `$geoNear`).
- Add CRUD/query methods in `src/services/mongo.ts` following existing patterns (`withMongoRetry`, etc.).

### 2. Data import script

Create `scripts/import-tefillin-stations.ts` (or `.js`) that:

- Reads the client Excel file (path via env or CLI arg, e.g. `TEFFILIN_STATIONS_XLSX=./data/stations.xlsx`).
- Supports columns: **name**, **address**, **latitude**, **longitude** (Hebrew/English header names — detect flexibly).
- If lat/lng missing but address exists: geocode via a free/reasonable API (e.g. Nominatim or Google if key in env). Log failures; skip bad rows.
- Upserts into `tefillin_stations` (idempotent re-run).
- Prints summary: imported / skipped / geocoded count.

Add npm script: `"import:tefillin-stations": "ts-node scripts/import-tefillin-stations.ts"`.

**Note:** Excel file is not in repo yet — use a `data/` placeholder + README note; script must work once client provides the file (~500 rows).

### 3. Nearest-stations service

Create `src/services/tefillinStationsService.ts`:

- `findNearestStations(lat, lng, limit = 8)` — return sorted by distance.
- Use **Haversine** or MongoDB `$geoNear` / `$geoWithin` — pick one; for ~500 points either is fine.
- `formatStationsMessage(stations, userLat, userLng)` — Hebrew WhatsApp-friendly list, RTL-friendly numbering.

Example output shape:

```
📍 עמדות תפילין קרובות אליך:

1. שם העמדה
   📫 רחוב X 12, תל אביב
   🚶 1.2 ק"מ

2. ...
```

Handle edge cases:

- No stations within reasonable radius → friendly Hebrew message.
- Invalid coordinates → reuse pattern from `incomingLocationFlow.ts`.
- DB empty → tell user stations data not loaded yet (admin message in logs).

### 4. Bot conversation flow

**New in-memory state** in `src/bot/messageHandler/state.ts`:

```ts
awaitingTefillinStationsLocation: Set<string>
```

**Button handler** — `src/bot/messageHandler/interactiveButtonFlow.ts`:

- Recognize button payloads: `tefillin_stations`, `עמדות תפילין`, and Hebrew variants (follow existing `normalizedButton` / `cleanButton` pattern).
- On match: add phone to `awaitingTefillinStationsLocation`, send location request via `twilioService.sendMessage()`:

  > "שלח/י את המיקום הנוכחי שלך (📎 ← מיקום) ואמצא עבורך את עמדות התפילין הקרובות."

- Do **not** set `creatingReminderType` or `awaitingCustomLocation` — this is a separate flow.

**Location handler** — extend `src/bot/messageHandler/incomingLocationFlow.ts` (or a dedicated `tefillinStationsLocationFlow.ts`):

- Check `awaitingTefillinStationsLocation` **before** or **alongside** `awaitingCustomLocation`.
- On match: call `tefillinStationsService`, send formatted results, clear state, optionally send main menu again.
- Must **not** overwrite `user.location` in Mongo (this is a lookup-only flow, unlike reminder custom-location).

**Text fallback** — `src/bot/messageHandler/incomingMessageFlow.ts`:

- If user types "עמדות תפילין" / "tefillin stations" → start same flow.

**Webhook fallback** — `src/index.ts` line ~198 currently rejects unsolicited location pins. After this feature, if user is in `awaitingTefillinStationsLocation`, location should be handled (via handler returning true).

### 5. Main menu button

Main menu uses Twilio Quick Reply template (`mainMenu` / `womanMenu` in `src/config/index.ts` → `src/bot/messageHandler/menus.ts`).

- Add config note / env for updated template SID if needed.
- Update **freeform fallback menu** in `sendMainMenu()` to include the new option.
- Document in code comment: **Twilio Console** must add button "📍 עמדות תפילין" with payload `tefillin_stations` to `mainMenu` and `womanMenu` templates (client/Twilio admin task).

### 6. Types & logging

- Add `TefillinStation` type in `src/types/index.ts`.
- Log station lookups to `message_log` optionally with `template_key: "tefillin_stations_lookup"` (follow `twilio.ts` patterns) — only if low effort.

---

## Files to touch (expected)

| Area | Files |
|------|-------|
| Types | `src/types/index.ts` |
| State | `src/bot/messageHandler/state.ts` |
| Button flow | `src/bot/messageHandler/interactiveButtonFlow.ts` |
| Location flow | `src/bot/messageHandler/incomingLocationFlow.ts` (+ optional new flow file) |
| Text intent | `src/bot/messageHandler/incomingMessageFlow.ts` |
| Menus | `src/bot/messageHandler/menus.ts` (fallback text) |
| Mongo | `src/services/mongo.ts` |
| Service | `src/services/tefillinStationsService.ts` (new) |
| Import | `scripts/import-tefillin-stations.ts` (new) |
| Config | `src/config/index.ts` (optional geocoding API key) |
| Package | `package.json` (script + xlsx parser dep if needed) |

---

## Acceptance criteria

- [ ] Button "📍 עמדות תפילין" starts location-request flow without affecting reminder creation.
- [ ] Shared location returns 5–10 nearest stations with name, address, km distance.
- [ ] Unsolicited location outside this flow still gets existing rejection message.
- [ ] Import script loads ~500 stations from Excel into MongoDB.
- [ ] Geocoding works when Excel has addresses only.
- [ ] Hebrew messages are clear and match bot tone elsewhere.
- [ ] Existing tests/flows (tefillin reminder, custom location, settings) still work.
- [ ] `npm run build` passes with no new linter errors.

---

## Out of scope (do not implement unless asked)

- Dashboard UI for stations
- Monthly data refresh / admin panel
- Maps links or Waze deep links (nice-to-have only if trivial)
- Changing Twilio templates in Twilio Console (document the required payload instead)

---

## Implementation notes

- Follow existing patterns: async webhook ACK stays non-blocking (`src/index.ts`).
- Reuse location validation from `incomingLocationFlow.ts`.
- Keep diff minimal — no unrelated refactors.
- If Excel library needed, use `xlsx` or `exceljs` — check what's already in `package.json` first.
- Add a small unit test for Haversine/distance sort if the project has a test setup; otherwise manual test notes in PR description.

---

## Test plan (manual)

1. Run import script with sample Excel (create 3–5 row fixture in `data/sample-stations.xlsx` for dev).
2. Start bot locally; send any message → main menu.
3. Tap / type "עמדות תפילין" → verify location prompt.
4. Share Tel Aviv coordinates → verify ordered station list.
5. Share location without starting flow → verify old rejection message still appears.
6. Start tefillin *reminder* custom location flow → verify it still saves `geo:lat,lng` to user profile.
