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
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];

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

        logger.debug(
          `🧪 TEST MODE: Checking reminder ${setting.id} (${setting.reminder_type}) for ${user.phone_number}, test_time: ${setting.test_time || 'none'}`
        );

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
          eventTime = await hebcalService.getTefilinTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
        case "candle_lighting":
          // Candle lighting is sent at 8:00 AM on Friday, not based on event time
          const today = new Date();
          const dayOfWeek = today.getDay(); // 0 = Sunday, 5 = Friday
          if (dayOfWeek === 5) {
            // It's Friday - check if it's 8:00 AM
            const now = new Date();
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            return currentHour === 8 && currentMinute === 0;
          }
          return false;
        case "shema":
          eventTime = await hebcalService.getShemaTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
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
      return timezoneService.isTimeToSendReminder(
        finalReminderTime,
        userTimezone
      );
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
      // Get current time in Israel timezone (Asia/Jerusalem) for test mode
      const now = new Date();
      const israelTimeString = now.toLocaleString("en-US", {
        timeZone: "Asia/Jerusalem",  // ✅ Use Israel time
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      
      const [currentHour, currentMinute] = israelTimeString.split(":").map(Number);
      const currentTimeMinutes = currentHour * 60 + currentMinute;
      
      logger.debug(
        `🧪 TEST MODE: Current time in Israel: ${currentHour}:${String(currentMinute).padStart(2, "0")} (${currentTimeMinutes} min)`
      );

      // TEST MODE: If manual test_time is set, use it instead of calculating
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
        
        // For testing: trigger exactly when test_time arrives or has passed
        // No window, no delay - just check if current time >= test_time
        const shouldTrigger = currentTimeMinutes >= testTimeMinutes;
        
        logger.info(
          `🧪 TEST MODE: Checking reminder ${setting.id} - ` +
          `Current: ${currentHour}:${String(currentMinute).padStart(2, "0")} (${currentTimeMinutes} min), ` +
          `Test Time: ${setting.test_time} (${testTimeMinutes} min), ` +
          `Time has ${shouldTrigger ? 'PASSED' : 'NOT YET COME'}, ` +
          `Should Trigger: ${shouldTrigger}`
        );
        
        if (shouldTrigger) {
          logger.info(
            `🧪 TEST MODE: ✅ TRIGGERING reminder for ${user.phone_number} - ` +
            `Test time ${setting.test_time} has arrived! ` +
            `Current: ${currentHour}:${String(currentMinute).padStart(2, "0")}`
          );
        }
        
        return shouldTrigger;
      }

      // Otherwise, use calculated time (existing logic)
      // Get event time based on reminder type
      let eventTime: string | null = null;

      switch (setting.reminder_type) {
        case "tefillin":
          eventTime = await hebcalService.getTefilinTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
        case "candle_lighting":
          // In test mode, trigger on any day if it's around 8:00 AM
          return currentHour === 8 && currentMinute >= 0 && currentMinute < config.testMode.triggerWindowMinutes;
        case "shema":
          eventTime = await hebcalService.getShemaTime(
            user.location || "Jerusalem",
            dateStr
          );
          break;
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

      // In test mode: trigger exactly when reminder time arrives or has passed (no window)
      const shouldTrigger = currentTimeMinutes >= reminderTimeMinutes;

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
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];
      let eventTime: string | null = null;
      let additionalData: Record<string, string> = {};

      // Handle different reminder types
      switch (setting.reminder_type) {
        case "tefillin": {
          eventTime = await hebcalService.getTefilinTime(location, todayStr);
          if (!eventTime) {
            logger.warn(
              `No tefillin time found for ${location} on ${todayStr}`
            );
            return;
          }

          // Calculate reminder time (before tefillin time)
          const reminderTime = timezoneService.calculateReminderTime(
            eventTime,
            setting.time_offset_minutes
          );

          const message = `📿 תזכורת: הנחת תפילין\n\n⏰ זמן תפילין: ${eventTime}\n🕐 תזכורת: ${reminderTime}`;
          await twilioService.sendMessage(user.phone_number, message);
          break;
        }

        case "candle_lighting": {
          // Special handling: send at 8:00 AM on Friday
          const today = new Date();
          const dayOfWeek = today.getDay();

          if (dayOfWeek === 5) {
            // Friday
            if (!user.location || user.location === "not_specified") {
              // Send all cities' times
              const cities = [
                "Jerusalem",
                "Beer Sheva",
                "Tel Aviv",
                "Eilat",
                "Haifa",
              ];
              let message = "🕯️ תזכורת: הדלקת נרות שבת\n\n";

              for (const city of cities) {
                const candleTime = await hebcalService.getCandleLightingTime(
                  city,
                  todayStr
                );
                if (candleTime) {
                  // Calculate 15 minutes before
                  const [hours, minutes] = candleTime.split(":").map(Number);
                  const reminderMinutes = minutes - 15;
                  const reminderHours = reminderMinutes < 0 ? hours - 1 : hours;
                  const finalMinutes =
                    reminderMinutes < 0
                      ? 60 + reminderMinutes
                      : reminderMinutes;
                  const reminderTime = `${String(reminderHours).padStart(
                    2,
                    "0"
                  )}:${String(finalMinutes).padStart(2, "0")}`;

                  message += `📍 ${city}: ${reminderTime} (כניסת שבת: ${candleTime})\n`;
                }
              }

              await twilioService.sendMessage(user.phone_number, message);
            } else {
              // Send specific city time
              const candleTime = await hebcalService.getCandleLightingTime(
                user.location,
                todayStr
              );
              if (candleTime) {
                // Calculate 15 minutes before
                const [hours, minutes] = candleTime.split(":").map(Number);
                const reminderMinutes = minutes - 15;
                const reminderHours = reminderMinutes < 0 ? hours - 1 : hours;
                const finalMinutes =
                  reminderMinutes < 0 ? 60 + reminderMinutes : reminderMinutes;
                const reminderTime = `${String(reminderHours).padStart(
                  2,
                  "0"
                )}:${String(finalMinutes).padStart(2, "0")}`;

                const message = `🕯️ תזכורת: הדלקת נרות שבת\n\n📍 עיר: ${user.location}\n⏰ כניסת שבת: ${candleTime}\n🕐 תזכורת: ${reminderTime}`;
                await twilioService.sendMessage(user.phone_number, message);
              }
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

          const message = `📖 תזכורת: זמן קריאת שמע\n\n⏰ זמן קריאת שמע: ${eventTime}\n🕐 תזכורת: ${reminderTime}`;
          await twilioService.sendMessage(user.phone_number, message);
          break;
        }

        default:
          logger.warn(`Unknown reminder type: ${setting.reminder_type}`);
          return;
      }

      logger.info(
        `Reminder sent to ${user.phone_number} for ${setting.reminder_type}`
      );
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
