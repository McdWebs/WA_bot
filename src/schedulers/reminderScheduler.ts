import cron from "node-cron";
// Database layer: use MongoDB instead of Supabase
import mongoService from "../services/mongo";
import hebcalService from "../services/hebcal";
import twilioService from "../services/twilio";
import timezoneService from "../utils/timezone";
import messageTemplateService from "../utils/messageTemplates";
import logger from "../utils/logger";
import { ReminderSetting, User } from "../types";
import { config } from "../config";

const ISRAEL_TZ = "Asia/Jerusalem";

export class ReminderScheduler {
  private isRunning = false;

  start(): void {
    if (this.isRunning) {
      logger.warn("Reminder scheduler is already running");
      return;
    }

    // WARNING: Test mode check
    if (config.testMode.enabled) {
      logger.warn("⚠️⚠️⚠️ TEST MODE ENABLED ⚠️⚠️⚠️");
      logger.warn("Reminders will trigger based on CURRENT TIME, not scheduled time!");
      logger.warn("This is ONLY for testing - DO NOT use in production!");
      logger.warn(`Trigger window: ${config.testMode.triggerWindowMinutes} minutes`);
    }

    // Run every minute to check for reminders
    cron.schedule("* * * * *", async () => {
      logger.info(`🧪 TEST MODE: Scheduler running at ${new Date().toISOString()}`);
      await this.checkAndSendReminders();
    });

    this.isRunning = true;
    logger.info("Reminder scheduler started");
    
    // TEST MODE: Run immediately on startup for testing
    if (config.testMode.enabled) {
      logger.info("🧪 TEST MODE: Running initial check immediately...");
      setImmediate(() => {
        this.checkAndSendReminders().catch((err) => {
          logger.error("🧪 TEST MODE: Error in initial check:", err);
        });
      });
    }
  }

  private async checkAndSendReminders(): Promise<void> {
    try {
      // Check if it's Saturday (Shabbat) in Israel - don't send any reminders on Shabbat
      const dayOfWeekInIsrael = timezoneService.getDayOfWeekInTimezone(ISRAEL_TZ);
      if (dayOfWeekInIsrael === 6) {
        logger.info(`Shabbat detected (Saturday in Israel) - skipping all reminder checks`);
        return;
      }

      logger.info(`🧪 TEST MODE: Starting reminder check at ${new Date().toISOString()}`);
      
      // Get all active reminder settings with user data
      const settings = await mongoService.getAllActiveReminderSettings();

      logger.info(`🧪 TEST MODE: Fetched ${settings.length} active reminder(s) from database`);

      if (settings.length === 0) {
        logger.info("🧪 TEST MODE: No active reminders found - nothing to check");
        return;
      }

      // Log all reminders with test_time for debugging
      for (const setting of settings) {
        logger.info(
          `🧪 TEST MODE: Reminder ${setting.id} (${setting.reminder_type}) - ` +
          `enabled: ${setting.enabled}, test_time: ${setting.test_time || 'none'}, ` +
          `user: ${(setting as any).users?.phone_number || 'unknown'}`
        );
      }

      logger.debug(`🧪 TEST MODE: Checking ${settings.length} active reminder(s)`);

      // Group settings by user
      const userSettingsMap = new Map<
        string,
        { user: User; settings: ReminderSetting[] }
      >();

      for (const setting of settings) {
        // Extract user from joined data
        const user = setting.users;
        if (!user) continue;

        if (!userSettingsMap.has(user.phone_number)) {
          userSettingsMap.set(user.phone_number, { user, settings: [] });
        }

        // Extract just the ReminderSetting part (without users)
        const { users, ...reminderSetting } = setting;
        userSettingsMap.get(user.phone_number)!.settings.push(reminderSetting);
      }

      // Check each user's reminders
      for (const [
        phoneNumber,
        { user, settings: userSettings },
      ] of userSettingsMap) {
        await this.checkUserReminders(user, userSettings);
      }
    } catch (error: any) {
      // Only log network/DNS errors at debug level to reduce noise
      // These are usually temporary connectivity issues
      if (error?.message?.includes("ENOTFOUND") || error?.message?.includes("getaddrinfo")) {
        logger.debug(`MongoDB connection issue (likely temporary): ${error.message}`);
      } else {
      logger.error("Error checking reminders:", error);
      }
    }
  }

  private async checkUserReminders(
    user: User,
    settings: ReminderSetting[]
  ): Promise<void> {
    try {
      let location = user.location || "Jerusalem";
      const timezone = user.timezone || "Asia/Jerusalem";
      // Use Israel date so zmanim and "already sent today" match user's day
      const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);

      // Get today's Hebrew calendar data with fallback for invalid locations
      let hebcalData;
      try {
        hebcalData = await hebcalService.getHebcalData(location, todayStr);
      } catch (error: any) {
        // If location is invalid (404), try fallback locations
        if (error?.response?.status === 404 || error?.status === 404) {
          logger.warn(
            `Invalid location "${location}" for user ${user.phone_number}, trying fallback locations`
          );

          // Try common fallback locations
          const fallbackLocations = [
            "Jerusalem",
            "Tel Aviv",
            "Haifa",
            "New York",
            "Los Angeles",
          ];
          let foundValidLocation = false;

          for (const fallback of fallbackLocations) {
            try {
              hebcalData = await hebcalService.getHebcalData(
                fallback,
                todayStr
              );
              location = fallback;
              foundValidLocation = true;
              logger.info(
                `Using fallback location "${fallback}" for user ${user.phone_number}`
              );

              // Update user's location in database to fix it for future
              await mongoService.updateUser(user.phone_number, {
                location: fallback,
              });
              break;
            } catch (fallbackError) {
              // Continue to next fallback
              continue;
            }
          }

          if (!foundValidLocation) {
            logger.error(
              `Could not find valid location for user ${user.phone_number}, skipping reminders`
            );
            return;
          }
        } else {
          // Re-throw non-404 errors
          throw error;
        }
      }

      for (const setting of settings) {
        if (!setting.enabled) {
          logger.debug(`🧪 TEST MODE: Skipping disabled reminder ${setting.id} for ${user.phone_number}`);
          continue;
        }

        // Log at info when reminder has test_time so it's visible in production logs
        if (setting.test_time) {
          logger.info(
            `🧪 TEST MODE: Checking reminder ${setting.id} (${setting.reminder_type}) for ${user.phone_number}, test_time: ${setting.test_time}`
          );
        } else {
          logger.debug(
            `🧪 TEST MODE: Checking reminder ${setting.id} (${setting.reminder_type}) for ${user.phone_number}, test_time: ${setting.test_time || 'none'}`
          );
        }

        const shouldSend = await this.shouldSendReminder(
          setting,
          user,
          hebcalData,
          todayStr
        );

        if (shouldSend) {
          logger.info(`🧪 TEST MODE: ✅ Sending reminder ${setting.id} to ${user.phone_number}`);
          await this.sendReminder(user, setting, hebcalData, location);
        } else {
          logger.debug(`🧪 TEST MODE: Not sending reminder ${setting.id} - shouldSend=false`);
        }
      }
    } catch (error) {
      logger.error(
        `Error checking reminders for user ${user.phone_number}:`,
        error
      );
    }
  }

  private async shouldSendReminder(
    setting: ReminderSetting,
    user: User,
    hebcalData: any,
    dateStr: string
  ): Promise<boolean> {
    try {
      // TEST MODE: If enabled, trigger reminders based on current time
      if (config.testMode.enabled) {
        logger.warn(`🧪 TEST MODE ENABLED - Using current time for reminder checks (NOT FOR PRODUCTION)`);
        return this.shouldSendReminderTestMode(setting, user, hebcalData, dateStr);
      }

      // PRODUCTION MODE: Normal timezone-based logic
      let eventTime: string | null = null;

      // Get event time based on reminder type
      switch (setting.reminder_type) {
        case "tefillin":
          // For tefillin reminders we schedule relative to SUNSET (end time),
          // not the earliest time for putting on tefillin.
          eventTime = await hebcalService.getSunsetTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
        case "candle_lighting": {
          const dayOfWeekInIsrael = timezoneService.getDayOfWeekInTimezone(ISRAEL_TZ);
          if (dayOfWeekInIsrael !== 5) return false;

          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;
          if (lastSentDate === israelTodayStr) {
            logger.debug(
              `Reminder ${setting.id} (candle_lighting) already sent today (${lastSentDate}), skipping duplicate send`
            );
            return false;
          }

          // Option 1: 8:00 AM Friday (time_offset_minutes === 0)
          if (setting.time_offset_minutes === 0) {
            const israelTimeString = new Date().toLocaleString("en-US", {
              timeZone: ISRAEL_TZ,
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });
            const [currentHour, currentMinute] = israelTimeString.split(":").map(Number);
            return currentHour === 8 && currentMinute === 0;
          }

          // Option 2 & 3: 1 hour or 2 hours before candle lighting (time_offset_minutes -60 or -120)
          const candleTime = await hebcalService.getCandleLightingTime(
            user.location || "Jerusalem",
            dateStr
          );
          if (!candleTime) return false;

          const reminderTime = timezoneService.calculateReminderTime(
            candleTime,
            setting.time_offset_minutes
          );
          const userTimezone = user.timezone || "Asia/Jerusalem";
          const locationTimezone = hebcalData.location?.tzid || "Asia/Jerusalem";
          let finalReminderTime = reminderTime;
          if (locationTimezone !== userTimezone) {
            finalReminderTime = timezoneService.convertTimeToTimezone(
              reminderTime,
              locationTimezone,
              userTimezone
            );
          }
          return timezoneService.isTimeToSendReminder(finalReminderTime, userTimezone);
        }
        case "shema":
          eventTime = await hebcalService.getShemaTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
        case "taara": {
          // Tahara: send at user-chosen time (stored as test_time or time_offset_minutes from midnight)
          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;
          if (lastSentDate === israelTodayStr) return false;
          const timeStr =
            (setting as any).test_time ||
            (() => {
              const mins = setting.time_offset_minutes;
              const h = Math.floor(Math.abs(mins) / 60) % 24;
              const m = Math.abs(mins) % 60;
              return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
            })();
          return timezoneService.isTimeToSendReminder(timeStr, user.timezone || ISRAEL_TZ);
        }
        case "clean_7": {
          // 7 clean days: send daily at 09:00; template gets day number (1–7) and today's date
          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;
          if (lastSentDate === israelTodayStr) return false;
          const startDate = (setting as any).clean_7_start_date as string | undefined;
          if (!startDate) return false;
          const start = new Date(startDate + "T12:00:00Z").getTime();
          const today = new Date(israelTodayStr + "T12:00:00Z").getTime();
          const daysDiff = Math.floor((today - start) / (24 * 60 * 60 * 1000));
          const dayNumber = daysDiff + 1;
          if (dayNumber < 1 || dayNumber > 7) return false;
          return timezoneService.isTimeToSendReminder("09:00", user.timezone || ISRAEL_TZ);
        }
        default:
          return false;
      }

      if (!eventTime) {
        return false;
      }

      // Calculate reminder time
      const reminderTime = timezoneService.calculateReminderTime(
        eventTime,
        setting.time_offset_minutes
      );

      // Convert to user's timezone if needed
      const userTimezone = user.timezone || "Asia/Jerusalem";
      const locationTimezone = hebcalData.location?.tzid || "Asia/Jerusalem";

      let finalReminderTime = reminderTime;
      if (locationTimezone !== userTimezone) {
        finalReminderTime = timezoneService.convertTimeToTimezone(
          reminderTime,
          locationTimezone,
          userTimezone
        );
      }

      // Check if it's time to send
      const shouldSend = timezoneService.isTimeToSendReminder(
        finalReminderTime,
        userTimezone
      );

      if (shouldSend) {
        const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
        const lastSentDate = setting.last_sent_at
          ? setting.last_sent_at.split("T")[0]
          : null;

        if (lastSentDate === israelTodayStr) {
          logger.debug(
            `Reminder ${setting.id} already sent today (${lastSentDate}), skipping duplicate send`
          );
          return false;
        }
      }

      return shouldSend;
    } catch (error) {
      logger.error("Error checking if should send reminder:", error);
      return false;
    }
  }

  /**
   * TEST MODE: Check if reminder should be sent based on current time
   * This bypasses timezone calculations and triggers reminders based on current time
   * ONLY FOR TESTING - NOT FOR PRODUCTION
   */
  private async shouldSendReminderTestMode(
    setting: ReminderSetting,
    user: User,
    hebcalData: any,
    dateStr: string
  ): Promise<boolean> {
    try {
      const now = new Date();
      // For test_time: use server (UTC) time so "current time" = when the server thinks it is
      const utcHours = now.getUTCHours();
      const utcMinutes = now.getUTCMinutes();
      const currentTimeMinutesUtc = utcHours * 60 + utcMinutes;
      // Israel time still used for non–test_time logic below
      const israelTimeString = now.toLocaleString("en-US", {
        timeZone: "Asia/Jerusalem",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const [currentHour, currentMinute] = israelTimeString.split(":").map(Number);
      const currentTimeMinutes = currentHour * 60 + currentMinute;

      // TEST MODE: If manual test_time is set, compare against UTC (server time)
      if (setting.test_time) {
        logger.debug(
          `🧪 TEST MODE: Found test_time="${setting.test_time}" for reminder ${setting.id} (${setting.reminder_type}) for ${user.phone_number}`
        );

        const [testHours, testMinutes] = setting.test_time.split(":").map(Number);
        if (isNaN(testHours) || isNaN(testMinutes)) {
          logger.error(
            `🧪 TEST MODE: Invalid test_time format "${setting.test_time}" for reminder ${setting.id}`
          );
          return false;
        }

        const testTimeMinutes = testHours * 60 + testMinutes;
        const windowMinutes = 1;
        const diffMinutes = Math.abs(currentTimeMinutesUtc - testTimeMinutes);
        const shouldTrigger = diffMinutes <= windowMinutes;

        logger.info(
          `🧪 TEST MODE: Checking reminder ${setting.id} (test_time=UTC) - ` +
          `Current UTC: ${String(utcHours).padStart(2, "0")}:${String(utcMinutes).padStart(2, "0")} (${currentTimeMinutesUtc} min), ` +
          `Test Time: ${setting.test_time} (${testTimeMinutes} min), diff=${diffMinutes}, ` +
          `Should Trigger: ${shouldTrigger}`
        );

        if (shouldTrigger) {
          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;

          if (lastSentDate === israelTodayStr) {
            logger.info(
              `🧪 TEST MODE: Reminder ${setting.id} already sent today (${lastSentDate}); test_time override: allowing send for testing`
            );
          }

          logger.info(
            `🧪 TEST MODE: ✅ TRIGGERING reminder for ${user.phone_number} - ` +
            `Test time ${setting.test_time} (UTC) has arrived! Current UTC: ${String(utcHours).padStart(2, "0")}:${String(utcMinutes).padStart(2, "0")}`
          );
        }

        return shouldTrigger;
      }

      logger.debug(
        `🧪 TEST MODE: Current time Israel: ${currentHour}:${String(currentMinute).padStart(2, "0")} (${currentTimeMinutes} min)`
      );

      // Otherwise, use calculated time (existing logic)
      // Get event time based on reminder type
      let eventTime: string | null = null;

      switch (setting.reminder_type) {
        case "tefillin":
          // In test mode as well, base tefillin reminders on SUNSET
          // so that offsets are calculated from the end time of the zman.
          eventTime = await hebcalService.getSunsetTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
        case "candle_lighting": {
          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const dayOfWeekInIsrael = timezoneService.getDayOfWeekInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;
          if (lastSentDate === israelTodayStr) {
            logger.debug(
              `🧪 TEST MODE: Reminder ${setting.id} (candle_lighting) already sent today (${lastSentDate}), skipping`
            );
            return false;
          }
          if (setting.time_offset_minutes === 0) {
            const shouldTriggerCandle =
              currentHour === 8 &&
              currentMinute >= 0 &&
              currentMinute < config.testMode.triggerWindowMinutes;
            return shouldTriggerCandle;
          }
          if (dayOfWeekInIsrael !== 5) return false;
          const candleTime = await hebcalService.getCandleLightingTime(
            user.location || "Jerusalem",
            dateStr
          );
          if (!candleTime) return false;
          const [eventHours, eventMinutes] = candleTime.split(":").map(Number);
          const eventTimeMinutes = eventHours * 60 + eventMinutes;
          const reminderTimeMinutes = eventTimeMinutes + setting.time_offset_minutes;
          const shouldTrigger = currentTimeMinutes === reminderTimeMinutes;
          return shouldTrigger;
        }
        case "shema":
          eventTime = await hebcalService.getShemaTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
        case "taara": {
          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;
          if (lastSentDate === israelTodayStr) return false;
          const timeStr =
            (setting as any).test_time ||
            (() => {
              const mins = setting.time_offset_minutes;
              const h = Math.floor(Math.abs(mins) / 60) % 24;
              const m = Math.abs(mins) % 60;
              return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
            })();
          const [th, tm] = timeStr.split(":").map(Number);
          const targetMin = th * 60 + tm;
          const window = config.testMode.triggerWindowMinutes;
          const diff = Math.abs(currentTimeMinutes - targetMin);
          return diff <= window;
        }
        case "clean_7": {
          const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const lastSentDate = setting.last_sent_at
            ? setting.last_sent_at.split("T")[0]
            : null;
          if (lastSentDate === israelTodayStr) return false;
          const startDate = (setting as any).clean_7_start_date as string | undefined;
          if (!startDate) return false;
          const start = new Date(startDate + "T12:00:00Z").getTime();
          const today = new Date(israelTodayStr + "T12:00:00Z").getTime();
          const daysDiff = Math.floor((today - start) / (24 * 60 * 60 * 1000));
          const dayNumber = daysDiff + 1;
          if (dayNumber < 1 || dayNumber > 7) return false;
          const targetMin = 9 * 60 + 0;
          const diff = Math.abs(currentTimeMinutes - targetMin);
          return diff <= config.testMode.triggerWindowMinutes;
        }
        default:
          return false;
      }

      if (!eventTime) {
        return false;
      }

      // Parse event time (format: "HH:MM")
      const [eventHours, eventMinutes] = eventTime.split(":").map(Number);
      const eventTimeMinutes = eventHours * 60 + eventMinutes;

      // Calculate reminder time in minutes (add offset: negative = before, positive = after)
      const reminderTimeMinutes = eventTimeMinutes + setting.time_offset_minutes;

      // In test mode: trigger ONLY in the exact minute of the reminder time
      // This prevents repeated triggers every minute after the time has passed
      const shouldTrigger = currentTimeMinutes === reminderTimeMinutes;

      logger.info(
        `🧪 TEST MODE: Checking reminder ${setting.id} (calculated) - ` +
        `Current: ${currentHour}:${String(currentMinute).padStart(2, "0")} (${currentTimeMinutes} min), ` +
        `Event Time: ${eventTime} (${eventTimeMinutes} min), ` +
        `Offset: ${setting.time_offset_minutes} min, ` +
        `Reminder Time: ${Math.floor(reminderTimeMinutes / 60)}:${String(reminderTimeMinutes % 60).padStart(2, "0")} (${reminderTimeMinutes} min), ` +
        `Time has ${shouldTrigger ? 'PASSED' : 'NOT YET COME'}, ` +
        `Should Trigger: ${shouldTrigger}`
      );

      if (shouldTrigger) {
        const israelTodayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
        const lastSentDate = setting.last_sent_at
          ? setting.last_sent_at.split("T")[0]
          : null;

        if (lastSentDate === israelTodayStr) {
          logger.debug(
            `🧪 TEST MODE: Reminder ${setting.id} already sent today (${lastSentDate}), skipping duplicate send`
          );
          return false;
        }

        logger.info(
          `🧪 TEST MODE: ✅ TRIGGERING reminder for ${user.phone_number} - ` +
          `Reminder time has arrived! ` +
          `Current: ${currentHour}:${String(currentMinute).padStart(2, "0")}, ` +
          `Calculated Reminder: ${Math.floor(reminderTimeMinutes / 60)}:${String(reminderTimeMinutes % 60).padStart(2, "0")}`
        );
      }

      return shouldTrigger;
    } catch (error) {
      logger.error("Error in test mode reminder check:", error);
      return false;
    }
  }

  private async sendReminder(
    user: User,
    setting: ReminderSetting,
    hebcalData: any,
    location: string
  ): Promise<void> {
    try {
      const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
      let eventTime: string | null = null;
      let additionalData: Record<string, string> = {};

      // Handle different reminder types
      switch (setting.reminder_type) {
        case "tefillin": {
          // For tefillin reminders we present and calculate based on sunset time
          eventTime = await hebcalService.getSunsetTime(location, todayStr);
          if (!eventTime) {
            logger.warn(
              `No sunset time found for ${location} on ${todayStr} (tefillin reminder)`
            );
            return;
          }

          // Calculate reminder time (before sunset time)
          const reminderTime = timezoneService.calculateReminderTime(
            eventTime,
            setting.time_offset_minutes
          );

          logger.info(
            `Sending tefillin reminder template to ${user.phone_number} (sunset=${eventTime}, reminder=${reminderTime})`
          );
          await twilioService.sendTemplateMessage(
            user.phone_number,
            "tefilinFinalMessage",
            {
              "1": eventTime,
              "2": reminderTime,
            }
          );
          break;
        }

        case "candle_lighting": {
          const dayOfWeekInIsrael = timezoneService.getDayOfWeekInTimezone(ISRAEL_TZ);
          if (dayOfWeekInIsrael !== 5) break;

          const offset = setting.time_offset_minutes ?? 0;
          const reminderTimeFromOffset = (candleTime: string) =>
            offset === 0
              ? "08:00"
              : timezoneService.calculateReminderTime(candleTime, offset);

          const candleFinalKey =
            user.gender === "female" && config.templates.candleLightingFinalMessageWomen?.trim()
              ? "candleLightingFinalMessageWomen"
              : "candleLightingFinalMessage";

          if (!user.location || user.location === "not_specified") {
            const cities = [
              "Jerusalem",
              "Beer Sheva",
              "Tel Aviv",
              "Eilat",
              "Haifa",
            ];
            for (const city of cities) {
              const candleTime = await hebcalService.getCandleLightingTime(
                city,
                todayStr
              );
              if (candleTime) {
                const reminderTime = reminderTimeFromOffset(candleTime);
                logger.info(
                  `Sending candle lighting template to ${user.phone_number} for city=${city} (candleTime=${candleTime}, reminder=${reminderTime})`
                );
                await twilioService.sendTemplateMessage(
                  user.phone_number,
                  candleFinalKey,
                  { "1": city, "2": candleTime, "3": reminderTime }
                );
              }
            }
          } else {
            const candleTime = await hebcalService.getCandleLightingTime(
              user.location,
              todayStr
            );
            if (candleTime) {
              const reminderTime = reminderTimeFromOffset(candleTime);
              logger.info(
                `Sending candle lighting template to ${user.phone_number} for city=${user.location} (candleTime=${candleTime}, reminder=${reminderTime})`
              );
              await twilioService.sendTemplateMessage(
                user.phone_number,
                candleFinalKey,
                {
                  "1": user.location,
                  "2": candleTime,
                  "3": reminderTime,
                }
              );
            }
          }
          break;
        }

        case "shema": {
          eventTime = await hebcalService.getShemaTime(location, todayStr);
          if (!eventTime) {
            logger.warn(`No shema time found for ${location} on ${todayStr}`);
            return;
          }

          // Calculate reminder time (before shema time)
          const reminderTime = timezoneService.calculateReminderTime(
            eventTime,
            setting.time_offset_minutes
          );

          logger.info(
            `Sending shema reminder template to ${user.phone_number} (shemaTime=${eventTime}, reminder=${reminderTime})`
          );
          await twilioService.sendTemplateMessage(
            user.phone_number,
            "shemaFinalMessage",
            {
              "1": eventTime,
              "2": reminderTime,
            }
          );
          break;
        }

        case "taara": {
          const sunsetTime =
            (await hebcalService.getSunsetTime(location, todayStr)) || "18:00";
          logger.info(
            `Sending taara reminder to ${user.phone_number} (sunset=${sunsetTime})`
          );
          await twilioService.sendTemplateMessage(
            user.phone_number,
            "taaraFinalMessage",
            { "1": sunsetTime }
          );
          break;
        }

        case "clean_7": {
          const startDate = (setting as any).clean_7_start_date as string | undefined;
          if (!startDate) {
            logger.warn(`clean_7 reminder ${setting.id} has no clean_7_start_date`);
            return;
          }
          const start = new Date(startDate + "T12:00:00Z").getTime();
          const today = new Date(todayStr + "T12:00:00Z").getTime();
          const daysDiff = Math.floor((today - start) / (24 * 60 * 60 * 1000));
          const dayNumber = String(daysDiff + 1);
          logger.info(
            `Sending clean_7 reminder to ${user.phone_number} (day ${dayNumber}, date=${todayStr})`
          );
          await twilioService.sendTemplateMessage(
            user.phone_number,
            "clean7FinalMessage",
            { "1": dayNumber }
          );
          break;
        }

        default:
          logger.warn(`Unknown reminder type: ${setting.reminder_type}`);
          return;
      }

      logger.info(
        `Reminder sent to ${user.phone_number} for ${setting.reminder_type}`
      );

      // Update last_sent_at to prevent duplicate sends
      if (setting.id) {
        try {
          await mongoService.updateReminderSettingById(setting.id, {
            last_sent_at: new Date().toISOString(),
          });
          logger.debug(
            `Updated last_sent_at for reminder ${setting.id} to prevent duplicates`
          );
        } catch (updateError) {
          logger.error(
            `Error updating last_sent_at for reminder ${setting.id}:`,
            updateError
          );
          // Don't throw - reminder was sent successfully, just tracking failed
        }
      }
    } catch (error) {
      logger.error(`Error sending reminder to ${user.phone_number}:`, error);
    }
  }

  stop(): void {
    this.isRunning = false;
    logger.info("Reminder scheduler stopped");
  }
}

export default new ReminderScheduler();
