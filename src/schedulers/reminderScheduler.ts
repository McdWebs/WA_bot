import cron from "node-cron";
// Database layer: use MongoDB instead of Supabase
import mongoService from "../services/mongo";
import hebcalService from "../services/hebcal";
import twilioService from "../services/twilio";
import timezoneService from "../utils/timezone";
import messageTemplateService from "../utils/messageTemplates";
import logger from "../utils/logger";
import { ReminderSetting, User } from "../types";

export class ReminderScheduler {
  private isRunning = false;

  start(): void {
    if (this.isRunning) {
      logger.warn("Reminder scheduler is already running");
      return;
    }

    // Run every minute to check for reminders
    cron.schedule("* * * * *", async () => {
      await this.checkAndSendReminders();
    });

    this.isRunning = true;
    logger.info("Reminder scheduler started");
  }

  private async checkAndSendReminders(): Promise<void> {
    try {
      // Get all active reminder settings with user data
      const settings = await mongoService.getAllActiveReminderSettings();

      if (settings.length === 0) {
        return;
      }

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
    } catch (error) {
      logger.error("Error checking reminders:", error);
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
        if (!setting.enabled) continue;

        const shouldSend = await this.shouldSendReminder(
          setting,
          user,
          hebcalData,
          todayStr
        );

        if (shouldSend) {
          await this.sendReminder(user, setting, hebcalData, location);
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
