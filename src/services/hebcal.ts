import axios from 'axios';
import { config } from '../config';
import { HebcalResponse, SunsetData, PrayerTime, ZmanimResponse } from '../types';
import logger from '../utils/logger';

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
    location: string = 'Jerusalem',
    date?: string
  ): Promise<HebcalResponse> {
    const cacheKey = this.getCacheKey(location, date || 'today');
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const params: any = {
        v: 1,
        cfg: 'json',
        geo: 'city',
        city: location,
        maj: 'on', // Major holidays
        min: 'on', // Minor holidays
        nx: 'on', // Rosh Chodesh
        mod: 'on', // Modern holidays
      };

      if (date) {
        params.start = date;
        params.end = date;
      }

      const response = await axios.get<HebcalResponse>(config.hebcal.apiBaseUrl, {
        params,
      });

      this.setCache(cacheKey, response.data);
      return response.data;
    } catch (error) {
      logger.error('Error fetching Hebcal data:', error);
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
        cfg: 'json',
        latitude: latitude.toString(),
        longitude: longitude.toString(),
      };

      if (date) {
        params.date = date;
      }

      const response = await axios.get<ZmanimResponse>('https://www.hebcal.com/zmanim', {
        params,
      });

      logger.info(`Zmanim data retrieved for lat: ${latitude}, lon: ${longitude}, date: ${date || 'today'}`);
      return response.data;
    } catch (error) {
      logger.error('Error fetching Zmanim data:', error);
      return null;
    }
  }

  async getSunsetTime(location: string = 'Jerusalem', date?: string): Promise<string | null> {
    try {
      // First, get location coordinates from Hebcal calendar API
      const data = await this.getHebcalData(location, date);
      const today = date ? new Date(date) : new Date();
      const todayStr = today.toISOString().split('T')[0];

      const latitude = data.location?.latitude || 31.7683; // Default to Jerusalem
      const longitude = data.location?.longitude || 35.2137; // Default to Jerusalem
      
      // Try to get sunset from Zmanim API (most accurate)
      logger.info(`Getting sunset from Zmanim API for ${location} (lat: ${latitude}, lon: ${longitude})`);
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
          logger.info(`Sunset time from Zmanim API: ${sunsetTime} (from ${sunsetISO})`);
          return sunsetTime;
        }
        // Fallback: use Date parsing (may have timezone issues)
        const sunsetDate = new Date(sunsetISO);
        const hours = sunsetDate.getHours();
        const minutes = sunsetDate.getMinutes();
        const sunsetTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        logger.info(`Sunset time from Zmanim API (parsed): ${sunsetTime}`);
        return sunsetTime;
      }

      // Fallback: Use default sunset time based on month (only if Zmanim API fails)
      const month = today.getMonth() + 1; // 1-12
      let approximateSunset: string;
      if (month === 12) approximateSunset = '16:30';
      else if (month === 1) approximateSunset = '16:45';
      else if (month === 2) approximateSunset = '17:15';
      else if (month === 11) approximateSunset = '16:45';
      else {
        const isSummer = month >= 4 && month <= 9; // April-September
        approximateSunset = isSummer ? '19:30' : '17:00';
      }
      logger.warn(`Using approximate sunset time: ${approximateSunset} (Zmanim API unavailable)`);
      return approximateSunset;
    } catch (error) {
      logger.error('Error getting sunset time:', error);
      // Final fallback: return default sunset time
      const today = date ? new Date(date) : new Date();
      const month = today.getMonth() + 1;
      let approximateSunset: string;
      if (month === 12) approximateSunset = '16:30';
      else if (month === 1) approximateSunset = '16:45';
      else if (month === 2) approximateSunset = '17:15';
      else if (month === 11) approximateSunset = '16:45';
      else {
        const isSummer = month >= 4 && month <= 9;
        approximateSunset = isSummer ? '19:30' : '17:00';
      }
      logger.warn(`Error occurred, using approximate sunset time: ${approximateSunset}`);
      return approximateSunset;
    }
  }

  async getCandleLightingTime(
    location: string = 'Jerusalem',
    date?: string
  ): Promise<string | null> {
    try {
      const data = await this.getHebcalData(location, date);
      const today = date ? new Date(date) : new Date();
      const todayStr = today.toISOString().split('T')[0];

      return this.extractCandleLightingTime(data, todayStr);
    } catch (error) {
      logger.error('Error getting candle lighting time:', error);
      return null;
    }
  }

  private extractCandleLightingTime(data: HebcalResponse, dateStr: string): string | null {
    // Look for candle lighting events in the items
    const candleEvent = data.items?.find(
      (item) =>
        item.category === 'candles' ||
        item.title?.toLowerCase().includes('candle') ||
        item.title?.toLowerCase().includes('lighting')
    );

    if (candleEvent && candleEvent.date) {
      // Extract time from date string (format: "2024-01-15T16:30:00+02:00")
      const date = new Date(candleEvent.date);
      return date.toTimeString().slice(0, 5);
    }

    return null;
  }

  async getPrayerTimes(
    location: string = 'Jerusalem',
    date?: string
  ): Promise<PrayerTime[]> {
    try {
      // Note: Hebcal API doesn't directly provide prayer times
      // This would need to be calculated or fetched from another source
      // For now, returning empty array - this can be extended with a prayer times API
      logger.warn('Prayer times not yet implemented - requires additional API');
      return [];
    } catch (error) {
      logger.error('Error getting prayer times:', error);
      return [];
    }
  }

  async getSunsetData(
    location: string = 'Jerusalem',
    date?: string
  ): Promise<SunsetData | null> {
    try {
      logger.info(`Getting sunset data for location: ${location}, date: ${date || 'today'}`);
      
      const sunset = await this.getSunsetTime(location, date);
      logger.info(`Sunset time result: ${sunset || 'null'}`);
      
      const candleLighting = await this.getCandleLightingTime(location, date);
      logger.info(`Candle lighting result: ${candleLighting || 'null'}`);
      
      const today = date ? new Date(date) : new Date();
      const dateStr = today.toISOString().split('T')[0];

      // getSunsetTime should always return a value now (never null)
      // But just in case, ensure we always have a sunset time
      const finalSunset = sunset || this.getDefaultSunsetTime(today);
      
      logger.info(`Final sunset data: ${finalSunset}, candle lighting: ${candleLighting || 'none'}`);

      return {
        date: dateStr,
        sunset: finalSunset,
        candle_lighting: candleLighting || undefined,
      };
    } catch (error) {
      logger.error('Error getting sunset data:', error);
      // Even on error, try to return a default value
      const today = date ? new Date(date) : new Date();
      const dateStr = today.toISOString().split('T')[0];
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
    return isSummer ? '19:30' : '17:30';
  }
}

export default new HebcalService();

