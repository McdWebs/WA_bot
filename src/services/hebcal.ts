import axios from "axios";
import { config } from "../config";
import {
  HebcalResponse,
  SunsetData,
  PrayerTime,
  ZmanimResponse,
} from "../types";
import logger from "../utils/logger";

export class HebcalService {
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour

  private getCacheKey(location: string, date: string): string {
    return `${location}_${date}`;
  }

  private getCached(key: string): any | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getHebcalData(
    location: string = "Jerusalem",
    date?: string
  ): Promise<HebcalResponse> {
    const cacheKey = this.getCacheKey(location, date || "today");
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const params: any = {
        v: 1,
        cfg: "json",
        geo: "city",
        city: location,
        maj: "on", // Major holidays
        min: "on", // Minor holidays
        nx: "on", // Rosh Chodesh
        mod: "on", // Modern holidays
      };

      if (date) {
        params.start = date;
        params.end = date;
      }

      const response = await axios.get<HebcalResponse>(
        config.hebcal.apiBaseUrl,
        {
          params,
          timeout: 5000, // 5 second timeout to prevent hanging
        }
      );

      this.setCache(cacheKey, response.data);
      return response.data;
    } catch (error) {
      logger.error("Error fetching Hebcal data:", error);
      throw error;
    }
  }

  /**
   * Get Zmanim (halachic times) from Hebcal Zmanim API
   * This includes accurate sunset times
   */
  async getZmanimData(
    latitude: number,
    longitude: number,
    date?: string
  ): Promise<ZmanimResponse | null> {
    try {
      const params: any = {
        cfg: "json",
        latitude: latitude.toString(),
        longitude: longitude.toString(),
      };

      if (date) {
        params.date = date;
      }

      const response = await axios.get<ZmanimResponse>(
        "https://www.hebcal.com/zmanim",
        {
          params,
          timeout: 5000, // 5 second timeout to prevent hanging
        }
      );

      logger.info(
        `Zmanim data retrieved for lat: ${latitude}, lon: ${longitude}, date: ${
          date || "today"
        }`
      );
      return response.data;
    } catch (error) {
      logger.error("Error fetching Zmanim data:", error);
      return null;
    }
  }

  async getSunsetTime(
    location: string = "Jerusalem",
    date?: string
  ): Promise<string | null> {
    try {
      // Normalize location to coordinates first – this avoids Hebcal "geo=city"
      // fallback issues (e.g. Tel Aviv sometimes resolving to Jerusalem).
      const normalizedLocation = (location || "Jerusalem").trim();

      // Known coordinates for a small set of supported cities
      const coordMap: Record<
        string,
        { latitude: number; longitude: number }
      > = {
        Jerusalem: { latitude: 31.7683, longitude: 35.2137 },
        "Tel Aviv": { latitude: 32.0853, longitude: 34.7818 },
        "Beer Sheva": { latitude: 31.252973, longitude: 34.791462 },
        Eilat: { latitude: 29.557669, longitude: 34.951925 },
        Haifa: { latitude: 32.794046, longitude: 34.989571 },
      };

      let latitude: number;
      let longitude: number;

      if (coordMap[normalizedLocation]) {
        ({ latitude, longitude } = coordMap[normalizedLocation]);
        logger.info(
          `Using hardcoded coordinates for ${normalizedLocation}: lat=${latitude}, lon=${longitude}`
        );
      } else {
        // Fallback: get location coordinates from Hebcal calendar API
        const data = await this.getHebcalData(location, date);
        latitude = data.location?.latitude || 31.7683; // Default to Jerusalem
        longitude = data.location?.longitude || 35.2137; // Default to Jerusalem
        logger.info(
          `Using Hebcal coordinates for ${location}: lat=${latitude}, lon=${longitude}`
        );
      }

      const today = date ? new Date(date) : new Date();
      const todayStr = today.toISOString().split("T")[0];

      // Try to get sunset from Zmanim API (most accurate)
      logger.info(
        `Getting sunset from Zmanim API for ${location} (lat: ${latitude}, lon: ${longitude})`
      );
      const zmanimData = await this.getZmanimData(latitude, longitude, date);

      if (zmanimData?.times?.sunset) {
        // Parse ISO format: "2025-12-09T16:35:00+02:00" -> "16:35"
        // The time is already in the location's timezone, extract it directly
        const sunsetISO = zmanimData.times.sunset;
        // Extract time part: "2025-12-09T16:35:00+02:00" -> "16:35:00"
        const timeMatch = sunsetISO.match(/T(\d{2}):(\d{2}):\d{2}/);
        if (timeMatch) {
          const hours = timeMatch[1];
          const minutes = timeMatch[2];
          const sunsetTime = `${hours}:${minutes}`;
          logger.info(
            `Sunset time from Zmanim API: ${sunsetTime} (from ${sunsetISO})`
          );
          return sunsetTime;
        }
        // Fallback: use Date parsing (may have timezone issues)
        const sunsetDate = new Date(sunsetISO);
        const hours = sunsetDate.getHours();
        const minutes = sunsetDate.getMinutes();
        const sunsetTime = `${String(hours).padStart(2, "0")}:${String(
          minutes
        ).padStart(2, "0")}`;
        logger.info(`Sunset time from Zmanim API (parsed): ${sunsetTime}`);
        return sunsetTime;
      }

      // Fallback: Use default sunset time based on month (only if Zmanim API fails)
      const month = today.getMonth() + 1; // 1-12
      let approximateSunset: string;
      if (month === 12) approximateSunset = "16:30";
      else if (month === 1) approximateSunset = "16:45";
      else if (month === 2) approximateSunset = "17:15";
      else if (month === 11) approximateSunset = "16:45";
      else {
        const isSummer = month >= 4 && month <= 9; // April-September
        approximateSunset = isSummer ? "19:30" : "17:00";
      }
      logger.warn(
        `Using approximate sunset time: ${approximateSunset} (Zmanim API unavailable)`
      );
      return approximateSunset;
    } catch (error) {
      logger.error("Error getting sunset time:", error);
      // Final fallback: return default sunset time
      const today = date ? new Date(date) : new Date();
      const month = today.getMonth() + 1;
      let approximateSunset: string;
      if (month === 12) approximateSunset = "16:30";
      else if (month === 1) approximateSunset = "16:45";
      else if (month === 2) approximateSunset = "17:15";
      else if (month === 11) approximateSunset = "16:45";
      else {
        const isSummer = month >= 4 && month <= 9;
        approximateSunset = isSummer ? "19:30" : "17:00";
      }
      logger.warn(
        `Error occurred, using approximate sunset time: ${approximateSunset}`
      );
      return approximateSunset;
    }
  }

  async getCandleLightingTime(
    location: string = "Jerusalem",
    date?: string
  ): Promise<string | null> {
    try {
      const data = await this.getHebcalData(location, date);
      const today = date ? new Date(date) : new Date();
      const todayStr = today.toISOString().split("T")[0];

      return this.extractCandleLightingTime(data, todayStr);
    } catch (error) {
      logger.error("Error getting candle lighting time:", error);
      return null;
    }
  }

  /**
   * Find the next Shabbat candle lighting time starting from today,
   * calculated as a fixed offset BEFORE sunset (to match Hebcal's
   * Shabbat page behaviour, e.g. 18 minutes before sundown).
   *
   * This lets us configure the reminder any day of the week, but
   * always relative to the coming Friday's sunset.
   */
  async getNextCandleLightingTime(
    location: string = "Jerusalem",
    maxDays: number = 14
  ): Promise<{ time: string | null; date: string | null }> {
    try {
      const today = new Date();

      for (let offset = 0; offset <= maxDays; offset++) {
        const candidate = new Date(today);
        candidate.setDate(today.getDate() + offset);

        // 5 = Friday
        const dayOfWeek = candidate.getDay();
        if (dayOfWeek !== 5) {
          continue;
        }

        const dateStr = candidate.toISOString().split("T")[0];

        // Get sunset time for that Friday using the Zmanim API
        const sunsetTime = await this.getSunsetTime(location, dateStr);
        if (!sunsetTime) {
          logger.warn(
            `No sunset time found for ${location} on ${dateStr} when calculating candle lighting`
          );
          continue;
        }

        // sunsetTime is "HH:MM" – compute candle lighting as 18 minutes before sunset
        const [hours, minutes] = sunsetTime.split(":").map(Number);
        let totalMinutes = hours * 60 + minutes - 18; // 18 minutes before

        if (totalMinutes < 0) {
          totalMinutes += 24 * 60; // wrap to previous day just in case
        }

        const candleHours = Math.floor(totalMinutes / 60) % 24;
        const candleMins = totalMinutes % 60;
        const candleTime = `${String(candleHours).padStart(2, "0")}:${String(
          candleMins
        ).padStart(2, "0")}`;

        logger.info(
          `Found next candle lighting time for ${location} on ${dateStr}: sunset=${sunsetTime}, candleLighting=${candleTime}`
        );

        return { time: candleTime, date: dateStr };
      }

      logger.warn(
        `No Friday with sunset time found for ${location} in the next ${maxDays} days`
      );
      return { time: null, date: null };
    } catch (error) {
      logger.error("Error getting next candle lighting time:", error);
      return { time: null, date: null };
    }
  }

  private extractCandleLightingTime(
    data: HebcalResponse,
    dateStr: string
  ): string | null {
    // Look for candle lighting events in the items for the specific date
    const candleEvent = data.items?.find((item) => {
      if (!item.date) return false;

      // Ensure the event is on the same Gregorian date
      const eventDateStr = item.date.split("T")[0];
      const isSameDate = eventDateStr === dateStr;

      return (
        isSameDate &&
        (item.category === "candles" ||
          item.title?.toLowerCase().includes("candle") ||
          item.title?.toLowerCase().includes("lighting"))
      );
    });

    if (candleEvent && candleEvent.date) {
      // Extract time in location's timezone from ISO string (e.g. "2024-01-15T16:30:00+02:00").
      // Do NOT use toTimeString() – it would convert to server timezone (e.g. UTC) and show wrong time (e.g. 14:27 instead of 16:27).
      const timeMatch = candleEvent.date.match(/T(\d{2}):(\d{2})/);
      if (timeMatch) {
        return `${timeMatch[1]}:${timeMatch[2]}`;
      }
      const date = new Date(candleEvent.date);
      return date.toTimeString().slice(0, 5);
    }

    return null;
  }

  async getPrayerTimes(
    location: string = "Jerusalem",
    date?: string
  ): Promise<PrayerTime[]> {
    try {
      // Note: Hebcal API doesn't directly provide prayer times
      // This would need to be calculated or fetched from another source
      // For now, returning empty array - this can be extended with a prayer times API
      logger.warn("Prayer times not yet implemented - requires additional API");
      return [];
    } catch (error) {
      logger.error("Error getting prayer times:", error);
      return [];
    }
  }

  async getSunsetData(
    location: string = "Jerusalem",
    date?: string
  ): Promise<SunsetData | null> {
    try {
      logger.info(
        `Getting sunset data for location: ${location}, date: ${
          date || "today"
        }`
      );

      const sunset = await this.getSunsetTime(location, date);
      logger.info(`Sunset time result: ${sunset || "null"}`);

      const candleLighting = await this.getCandleLightingTime(location, date);
      logger.info(`Candle lighting result: ${candleLighting || "null"}`);

      const today = date ? new Date(date) : new Date();
      const dateStr = today.toISOString().split("T")[0];

      // getSunsetTime should always return a value now (never null)
      // But just in case, ensure we always have a sunset time
      const finalSunset = sunset || this.getDefaultSunsetTime(today);

      logger.info(
        `Final sunset data: ${finalSunset}, candle lighting: ${
          candleLighting || "none"
        }`
      );

      return {
        date: dateStr,
        sunset: finalSunset,
        candle_lighting: candleLighting || undefined,
      };
    } catch (error) {
      logger.error("Error getting sunset data:", error);
      // Even on error, try to return a default value
      const today = date ? new Date(date) : new Date();
      const dateStr = today.toISOString().split("T")[0];
      return {
        date: dateStr,
        sunset: this.getDefaultSunsetTime(today),
        candle_lighting: undefined,
      };
    }
  }

  private getDefaultSunsetTime(date: Date): string {
    const month = date.getMonth() + 1; // 1-12
    const isSummer = month >= 4 && month <= 9; // April-September
    return isSummer ? "19:30" : "17:30";
  }

  /**
   * Get tefillin time (usually sunrise or misheyakir)
   * Uses Zmanim API to get accurate time
   */
  async getTefilinTime(
    location: string = "Jerusalem",
    date?: string
  ): Promise<string | null> {
    try {
      const data = await this.getHebcalData(location, date);
      const latitude = data.location?.latitude || 31.7683;
      const longitude = data.location?.longitude || 35.2137;

      const zmanimData = await this.getZmanimData(latitude, longitude, date);

      if (zmanimData?.times) {
        // Try misheyakir first (time when it's light enough to see), then sunrise
        const time =
          zmanimData.times.misheyakir ||
          zmanimData.times.sunrise ||
          zmanimData.times.alot;

        if (time) {
          const timeMatch = time.match(/T(\d{2}):(\d{2}):\d{2}/);
          if (timeMatch) {
            return `${timeMatch[1]}:${timeMatch[2]}`;
          }
          // Fallback parsing
          const timeDate = new Date(time);
          return `${String(timeDate.getHours()).padStart(2, "0")}:${String(
            timeDate.getMinutes()
          ).padStart(2, "0")}`;
        }
      }

      // Fallback: use sunrise approximation
      logger.warn(`Using approximate tefillin time (Zmanim API unavailable)`);
      return "06:00"; // Default sunrise approximation
    } catch (error) {
      logger.error("Error getting tefillin time:", error);
      return "06:00"; // Default fallback
    }
  }

  /**
   * Get Shema time (sof zman kriat shema)
   * Uses Zmanim API to get accurate time
   */
  async getShemaTime(
    location: string = "Jerusalem",
    date?: string
  ): Promise<string | null> {
    try {
      const data = await this.getHebcalData(location, date);
      const latitude = data.location?.latitude || 31.7683;
      const longitude = data.location?.longitude || 35.2137;

      const zmanimData = await this.getZmanimData(latitude, longitude, date);

      if (zmanimData?.times) {
        // Log available fields for debugging
        logger.info(
          `Available Zmanim fields: ${Object.keys(zmanimData.times).join(", ")}`
        );

        // Try camelCase field names (as returned by the API)
        // Priority: sofZmanShma (Gra) > sofZmanShmaMGA (Magen Avraham) > other MGA variants
        const time =
          zmanimData.times.sofZmanShma ||
          zmanimData.times.sofZmanShmaMGA ||
          zmanimData.times.sofZmanShmaMGA16Point1 ||
          zmanimData.times.sofZmanShmaMGA19Point8 ||
          // Fallback to underscore versions (in case API format changes)
          zmanimData.times.sof_zman_kriat_shema ||
          zmanimData.times.sof_zman_kriat_shema_ma ||
          zmanimData.times.sof_zman_shema;

        if (time) {
          logger.info(`Found Shema time: ${time}`);
          const timeMatch = time.match(/T(\d{2}):(\d{2}):\d{2}/);
          if (timeMatch) {
            return `${timeMatch[1]}:${timeMatch[2]}`;
          }
          // Fallback parsing
          const timeDate = new Date(time);
          return `${String(timeDate.getHours()).padStart(2, "0")}:${String(
            timeDate.getMinutes()
          ).padStart(2, "0")}`;
        }

        // If Shema time not found, try calculating from sunrise
        // Shema time is typically 3 hours after sunrise (according to some opinions)
        if (zmanimData.times.sunrise) {
          logger.warn(
            `Shema time field not found, calculating from sunrise: ${zmanimData.times.sunrise}`
          );
          const sunriseMatch = zmanimData.times.sunrise.match(
            /T(\d{2}):(\d{2}):\d{2}/
          );
          if (sunriseMatch) {
            let hours = parseInt(sunriseMatch[1]);
            let minutes = parseInt(sunriseMatch[2]);
            // Add 3 hours
            hours += 3;
            if (hours >= 24) hours -= 24;
            const shemaTime = `${String(hours).padStart(2, "0")}:${String(
              minutes
            ).padStart(2, "0")}`;
            logger.info(`Calculated Shema time: ${shemaTime}`);
            return shemaTime;
          }
        }
      }

      // Fallback: use approximation (usually around 3 hours after sunrise)
      logger.warn(`Using approximate shema time (Zmanim API unavailable)`);
      return "09:00"; // Default approximation
    } catch (error) {
      logger.error("Error getting shema time:", error);
      return "09:00"; // Default fallback
    }
  }
}

export default new HebcalService();
