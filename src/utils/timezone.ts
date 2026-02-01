import { config } from "../config";
import logger from "../utils/logger";

export class TimezoneService {
  /**
   * Attempts to detect timezone from location string
   * This is a simplified version - in production, you might want to use
   * a geocoding service like Google Maps API or similar
   */
  async detectTimezoneFromLocation(location: string): Promise<string> {
    // Common timezone mappings for major cities
    const timezoneMap: Record<string, string> = {
      jerusalem: "Asia/Jerusalem",
      telaviv: "Asia/Jerusalem",
      "tel aviv": "Asia/Jerusalem",
      haifa: "Asia/Jerusalem",
      beersheba: "Asia/Jerusalem",
      "beer sheva": "Asia/Jerusalem",
      eilat: "Asia/Jerusalem",
      newyork: "America/New_York",
      "new york": "America/New_York",
      losangeles: "America/Los_Angeles",
      "los angeles": "America/Los_Angeles",
      london: "Europe/London",
      paris: "Europe/Paris",
      berlin: "Europe/Berlin",
      moscow: "Europe/Moscow",
      sydney: "Australia/Sydney",
      melbourne: "Australia/Melbourne",
      toronto: "America/Toronto",
      chicago: "America/Chicago",
      miami: "America/New_York",
      boston: "America/New_York",
    };

    const normalizedLocation = location.toLowerCase().trim();

    // Check direct match
    if (timezoneMap[normalizedLocation]) {
      return timezoneMap[normalizedLocation];
    }

    // Check partial matches
    for (const [key, tz] of Object.entries(timezoneMap)) {
      if (
        normalizedLocation.includes(key) ||
        key.includes(normalizedLocation)
      ) {
        return tz;
      }
    }

    // Default to configured timezone
    logger.warn(
      `Could not detect timezone for location: ${location}, using default`
    );
    return config.defaultTimezone;
  }

  /**
   * Converts a time string to a specific timezone
   */
  convertTimeToTimezone(
    timeString: string,
    fromTimezone: string,
    toTimezone: string
  ): string {
    try {
      const today = new Date();
      const [hours, minutes] = timeString.split(":").map(Number);

      // Create date in source timezone
      const dateStr = today.toISOString().split("T")[0];
      const dateInSourceTz = new Date(
        `${dateStr}T${String(hours).padStart(2, "0")}:${String(
          minutes
        ).padStart(2, "0")}:00`
      );

      // Get timezone offset difference
      const sourceOffset = this.getTimezoneOffset(fromTimezone, dateInSourceTz);
      const targetOffset = this.getTimezoneOffset(toTimezone, dateInSourceTz);
      const offsetDiff = (targetOffset - sourceOffset) * 60 * 1000; // in milliseconds

      const convertedDate = new Date(dateInSourceTz.getTime() + offsetDiff);
      return convertedDate.toTimeString().slice(0, 5);
    } catch (error) {
      logger.error("Error converting timezone:", error);
      return timeString;
    }
  }

  /**
   * Gets timezone offset in minutes
   */
  private getTimezoneOffset(timezone: string, date: Date): number {
    try {
      const utcDate = new Date(
        date.toLocaleString("en-US", { timeZone: "UTC" })
      );
      const tzDate = new Date(
        date.toLocaleString("en-US", { timeZone: timezone })
      );
      return (tzDate.getTime() - utcDate.getTime()) / (1000 * 60);
    } catch (error) {
      logger.error(`Error getting timezone offset for ${timezone}:`, error);
      return 0;
    }
  }

  /**
   * Calculates reminder time based on event time and offset
   */
  calculateReminderTime(eventTime: string, offsetMinutes: number): string {
    try {
      const [hours, minutes] = eventTime.split(":").map(Number);
      // FIX: ADD offset instead of subtracting (negative = before, positive = after)
      const totalMinutes = hours * 60 + minutes + offsetMinutes;

      const reminderHours = Math.floor(totalMinutes / 60);
      const reminderMins = totalMinutes % 60;

      // Handle negative time (previous day)
      const finalHours = reminderHours < 0 ? 24 + reminderHours : reminderHours;
      const finalMins = reminderMins < 0 ? 60 + reminderMins : reminderMins;

      return `${String(finalHours).padStart(2, "0")}:${String(
        finalMins
      ).padStart(2, "0")}`;
    } catch (error) {
      logger.error("Error calculating reminder time:", error);
      return eventTime;
    }
  }

  /**
   * Returns the current date string (YYYY-MM-DD) in the given timezone.
   * Use this for "today" when scheduling reminders so server UTC doesn't cause wrong-day logic.
   */
  getDateInTimezone(timezone: string): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  }

  /**
   * Returns the current day of week (0 = Sunday, 6 = Saturday) in the given timezone.
   * Use this for Shabbat/Friday checks so server timezone doesn't cause wrong-day logic.
   */
  getDayOfWeekInTimezone(timezone: string): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
    });
    const dayName = formatter.format(new Date());
    const map: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };
    return map[dayName] ?? 0;
  }

  /**
   * Checks if current time matches the reminder time (within 1 minute tolerance)
   */
  isTimeToSendReminder(reminderTime: string, timezone: string): boolean {
    try {
      const now = new Date();
      const [hours, minutes] = reminderTime.split(":").map(Number);

      // Get current time in the specified timezone
      const tzTimeString = now.toLocaleString("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const [currentHours, currentMins] = tzTimeString.split(":").map(Number);

      // Check if within 1 minute
      const currentTotalMins = currentHours * 60 + currentMins;
      const reminderTotalMins = hours * 60 + minutes;
      const diff = Math.abs(currentTotalMins - reminderTotalMins);

      return diff <= 1;
    } catch (error) {
      logger.error("Error checking reminder time:", error);
      return false;
    }
  }
}

export default new TimezoneService();
