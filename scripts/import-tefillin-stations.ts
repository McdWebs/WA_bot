import "dotenv/config";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as XLSX from "xlsx";
import mongoService from "../src/services/mongo";
import { closeMongo } from "../src/services/mongo";
import type { TefillinStation } from "../src/types";

/**
 * Imports tefillin stations from the client Excel file into MongoDB.
 *
 * The real file has columns: שם בית העסק (name) | רחוב (street) |
 * מס רחוב (street #) | עיר (city) | שם איש קשר (contact) | טלפון (phone).
 * It has NO coordinates, so every row is geocoded from street+number+city via
 * the free Nominatim (OpenStreetMap) API. Results are cached to disk so
 * re-runs are fast and don't re-hit the API.
 *
 * Usage:
 *   npm run import:tefillin-stations -- [path] [--dry-run] [--limit=N]
 *
 * Defaults to the file shipped in data/. Set TEFILLIN_STATIONS_XLSX to override.
 */

const DEFAULT_XLSX = "data/מיקומי עמדות - אפליקציה פרחי.xlsx";
const CACHE_PATH = "data/geocode-cache.json";
const MAX_RETRIES = 4; // retries on 429 / 5xx / network errors
const BACKOFF_MS = [5000, 15000, 30000, 60000]; // escalating waits between retries
const USER_AGENT =
  "hidabroot-tefillin-stations-importer/1.0 (whatsapp reminder bot)";

/**
 * Geocoding provider. LocationIQ is Nominatim-compatible (same response shape)
 * but has a generous free tier that allows bulk geocoding, so it's used when
 * LOCATIONIQ_API_KEY is set. Otherwise we fall back to the public Nominatim
 * server (heavily rate-limited — fine for small/incremental runs only).
 */
const LOCATIONIQ_API_KEY = process.env.LOCATIONIQ_API_KEY || "";
const USE_LOCATIONIQ = LOCATIONIQ_API_KEY !== "";
const GEOCODE_URL = USE_LOCATIONIQ
  ? "https://us1.locationiq.com/v1/search"
  : "https://nominatim.openstreetmap.org/search";
// LocationIQ free tier rate-limits aggressively; ~1 req/sec keeps 429s rare.
// Public Nominatim wants <=1 req/sec.
const REQUEST_DELAY_MS = USE_LOCATIONIQ ? 1100 : 1500;

interface RawRow {
  name: string;
  street: string;
  streetNumber: string;
  city: string;
  contact: string;
  phone: string;
}

interface GeocodeCache {
  [query: string]: { lat: number; lng: number } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a Hebrew city name for loose comparison: drop spaces/hyphens,
 * unify קריית/קרית, and drop the "-יפו" suffix so "תל אביב" matches "תל אביב-יפו".
 */
function normCity(s: string): string {
  return (s || "")
    .replace(/יפו/g, "")
    .replace(/קריית/g, "קרית")
    .replace(/[\s\-־]/g, "")
    .trim();
}

/** True if the geocoder's returned city is the same place as our target city. */
function cityMatches(target: string, resultCity: string | undefined): boolean {
  if (!resultCity) return false;
  const a = normCity(target);
  const b = normCity(resultCity);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Strip stray leading/trailing punctuation (quotes/dots) seen in the source data. */
function cleanText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'.״׳]+/, "")
    .replace(/["'״׳]+$/, "")
    .trim();
}

/** Normalize a street number cell: 85.0 -> "85", "517/9" -> "517/9", 0 -> "". */
function cleanStreetNumber(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    if (value === 0) return "";
    return Number.isInteger(value) ? String(value) : String(value);
  }
  const s = String(value).trim();
  // Numeric-looking "85.0" -> "85"
  const asNum = Number(s);
  if (!Number.isNaN(asNum) && /^\d+(\.0+)?$/.test(s)) {
    return asNum === 0 ? "" : String(asNum);
  }
  return s;
}

function loadCache(): GeocodeCache {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    }
  } catch (e) {
    console.warn(`⚠️  Could not read geocode cache (${CACHE_PATH}):`, e);
  }
  return {};
}

function saveCache(cache: GeocodeCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.warn(`⚠️  Could not write geocode cache (${CACHE_PATH}):`, e);
  }
}

type GeocodeResult =
  | { status: "ok"; coords: { lat: number; lng: number }; city?: string }
  | { status: "empty" } // HTTP 200, but no match — safe to cache as a miss
  | { status: "error" }; // 429 / 5xx / network — must NOT be cached, should retry

/**
 * Single Nominatim call with retry+backoff on 429/5xx/network errors.
 * Distinguishes a genuine "no result" (cacheable) from a transient error
 * (not cacheable) so rate-limit failures never poison the cache.
 */
async function nominatimGeocode(query: string): Promise<GeocodeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const params: Record<string, string | number> = {
        q: query,
        format: "json",
        limit: 1,
        countrycodes: "il",
        addressdetails: 1,
        "accept-language": "he",
      };
      if (USE_LOCATIONIQ) params.key = LOCATIONIQ_API_KEY;

      const res = await axios.get(GEOCODE_URL, {
        params,
        headers: { "User-Agent": USER_AGENT },
        timeout: 20000,
        validateStatus: (s) => s === 200 || s === 404 || s === 429 || (s >= 500 && s < 600),
      });

      // LocationIQ returns 404 with {"error":"Unable to geocode"} for genuine misses.
      if (res.status === 404) {
        return { status: "empty" };
      }

      if (res.status === 200) {
        const hit = Array.isArray(res.data) ? res.data[0] : null;
        if (hit && hit.lat && hit.lon) {
          const a = hit.address || {};
          const city =
            a.city || a.town || a.village || a.municipality || a.suburb || a.county;
          return {
            status: "ok",
            coords: { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) },
            city,
          };
        }
        return { status: "empty" };
      }

      // 429 or 5xx → back off and retry
      if (attempt < MAX_RETRIES) {
        const wait = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        console.warn(
          `   ⏳ ${res.status} for "${query}" — backing off ${wait / 1000}s (retry ${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(wait);
        continue;
      }
      console.warn(`   ⚠️  giving up after ${MAX_RETRIES} retries (${res.status}) for "${query}"`);
      return { status: "error" };
    } catch (e: any) {
      if (attempt < MAX_RETRIES) {
        const wait = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        console.warn(
          `   ⏳ network error for "${query}" (${e?.message ?? e}) — retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s`
        );
        await sleep(wait);
        continue;
      }
      console.warn(`   ⚠️  giving up (network) for "${query}": ${e?.message ?? e}`);
      return { status: "error" };
    }
  }
  return { status: "error" };
}

/**
 * Geocode an address, trying progressively coarser queries:
 * street+number+city -> street+city -> city. Returns coords + the level used.
 * Live API calls are rate-limited and cached; callers should respect the
 * returned `live` flag to know whether they need to throttle.
 */
async function geocodeRow(
  row: RawRow,
  cache: GeocodeCache
): Promise<{ coords: { lat: number; lng: number } | null; level: string; live: boolean }> {
  const candidates: { q: string; level: string }[] = [];
  if (row.street && row.streetNumber) {
    candidates.push({
      q: `${row.street} ${row.streetNumber}, ${row.city}, ישראל`,
      level: "street+number",
    });
  }
  if (row.street) {
    candidates.push({ q: `${row.street}, ${row.city}, ישראל`, level: "street" });
  }
  candidates.push({ q: `${row.city}, ישראל`, level: "city" });

  let didLiveCall = false;
  for (const cand of candidates) {
    if (Object.prototype.hasOwnProperty.call(cache, cand.q)) {
      const cached = cache[cand.q];
      if (cached) return { coords: cached, level: `${cand.level} (cached)`, live: didLiveCall };
      continue; // cached genuine miss → try coarser
    }
    if (didLiveCall) await sleep(REQUEST_DELAY_MS);
    const result = await nominatimGeocode(cand.q);
    didLiveCall = true;

    if (result.status === "ok") {
      // Guard against the geocoder matching a same-named street in the WRONG
      // city (very common in Israel): for street-level queries, only accept a
      // result that lands in the target city. The city-level candidate IS the
      // city, so trust it even if OSM spells the name slightly differently.
      const isCityCandidate = cand.level === "city";
      if (isCityCandidate || cityMatches(row.city, result.city)) {
        cache[cand.q] = result.coords; // cache validated success
        saveCache(cache);
        return { coords: result.coords, level: cand.level, live: true };
      }
      cache[cand.q] = null; // wrong city → treat as a miss for this query
      saveCache(cache);
      continue;
    }
    if (result.status === "empty") {
      cache[cand.q] = null; // cache genuine miss; fall through to coarser query
      saveCache(cache);
      continue;
    }
    // status === "error": transient (429/5xx/network). Do NOT cache; abort this
    // row so a future re-run retries it instead of recording a false miss.
    return { coords: null, level: "error", live: true };
  }
  return { coords: null, level: "none", live: didLiveCall };
}

function parseRows(filePath: string): RawRow[] {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const out: RawRow[] = [];
  // Row 0 is the header.
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = cleanText(r[0]);
    const street = cleanText(r[1]);
    const streetNumber = cleanStreetNumber(r[2]);
    const city = cleanText(r[3]);
    const contact = cleanText(r[4]);
    const phone = cleanText(r[5]);
    if (!name && !street && !city) continue; // skip empty
    out.push({ name, street, streetNumber, city, contact, phone });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
  const positional = args.find((a) => !a.startsWith("--"));
  const filePath =
    positional || process.env.TEFILLIN_STATIONS_XLSX || DEFAULT_XLSX;

  if (!fs.existsSync(filePath)) {
    console.error(`❌ Excel file not found: ${filePath}`);
    process.exit(1);
  }

  console.log(
    `🌍 Geocoder: ${USE_LOCATIONIQ ? "LocationIQ" : "public Nominatim (rate-limited)"}`
  );
  console.log(`📄 Reading ${filePath}${dryRun ? " (DRY RUN)" : ""}`);
  const rows = parseRows(filePath).slice(0, limit);
  console.log(`   ${rows.length} data rows to process\n`);

  // Marks the start of this run; anything older is pruned at the end (only on a
  // full run, never a partial --limit run, to avoid deleting untouched rows).
  const runStartIso = new Date().toISOString();
  const isFullRun = limit === Infinity;

  if (!dryRun) {
    await mongoService.ensureTefillinStationsIndexes();
  }

  const cache = loadCache();
  let imported = 0;
  let geocodedLive = 0;
  let geocodedCached = 0;
  let skippedNoCity = 0;
  let skippedNoGeo = 0;
  let deferredRateLimited = 0;
  let preciseLevel = 0; // matched a street (good accuracy)
  let cityLevel = 0; // fell back to city center (approximate)

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `[${i + 1}/${rows.length}] ${row.name || "(ללא שם)"}`;

    if (!row.city) {
      console.log(`${label} — ⏭️  skipped (no city)`);
      skippedNoCity++;
      continue;
    }

    const { coords, level, live } = await geocodeRow(row, cache);
    if (live) {
      geocodedLive++;
    } else if (coords) {
      geocodedCached++;
    }

    if (!coords) {
      if (level === "error") {
        console.log(`${label} — 🔁 deferred (rate-limited; re-run to retry)`);
        deferredRateLimited++;
      } else {
        console.log(`${label} — ⏭️  skipped (no geocode for "${row.street} ${row.streetNumber}, ${row.city}")`);
        skippedNoGeo++;
      }
      continue;
    }

    const address = [
      [row.street, row.streetNumber].filter(Boolean).join(" "),
      row.city,
    ]
      .filter(Boolean)
      .join(", ");

    const station: Omit<TefillinStation, "id" | "created_at" | "updated_at"> = {
      name: row.name || address,
      address,
      street: row.street || undefined,
      street_number: row.streetNumber || undefined,
      city: row.city,
      contact_name: row.contact || undefined,
      phone: row.phone || undefined,
      latitude: coords.lat,
      longitude: coords.lng,
      location: { type: "Point", coordinates: [coords.lng, coords.lat] },
      source: "hidabroot",
    };

    if (!dryRun) {
      await mongoService.upsertTefillinStation(station);
    }
    imported++;
    if (level.startsWith("city")) {
      cityLevel++;
    } else {
      preciseLevel++;
    }
    console.log(
      `${label} — ✅ ${coords.lat.toFixed(4)},${coords.lng.toFixed(4)} (${level})`
    );
  }

  // Prune stale rows from previous imports (e.g. removed/renamed in the source).
  let removedStale = 0;
  if (!dryRun && isFullRun && imported > 0) {
    removedStale = await mongoService.deleteStaleTefillinStations(runStartIso);
  }

  console.log("\n──────── Summary ────────");
  console.log(`  Imported/upserted: ${imported}${dryRun ? " (dry run, not written)" : ""}`);
  console.log(`    ├ street-level:  ${preciseLevel} (precise)`);
  console.log(`    └ city-level:    ${cityLevel} (approx, no street match)`);
  console.log(`  Geocoded (live):   ${geocodedLive}`);
  console.log(`  Geocoded (cache):  ${geocodedCached}`);
  console.log(`  Skipped (no city): ${skippedNoCity}`);
  console.log(`  Skipped (no geo):  ${skippedNoGeo}`);
  console.log(`  Deferred (429):    ${deferredRateLimited}${deferredRateLimited ? "  ← re-run the script to retry these" : ""}`);
  console.log(`  Pruned (stale):    ${removedStale}`);
  console.log("─────────────────────────");
}

main()
  .catch((e) => {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo().catch(() => {});
  });
