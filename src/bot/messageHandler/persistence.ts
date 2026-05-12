import mongoService from "../../services/mongo";
import twilioService from "../../services/twilio";
import hebcalService from "../../services/hebcal";
import logger from "../../utils/logger";
import timezoneService from "../../utils/timezone";
import { config } from "../../config";
import type { ReminderType } from "../../types";
import { getCityNameInHebrew } from "./pure/cityNames";
import { parseTimeOfDayToMinutes } from "./pure/time";
import type { MessageHandlerMutableState } from "./state";
import { ISRAEL_TZ } from "./state";

/**
 * Saves reminder from time picker selection
 */
export async function saveReminderFromTimePicker(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  reminderType: ReminderType,
  timeId: string
): Promise<void> {
  try {
    logger.info(
      `💾 Attempting to save reminder: type="${reminderType}", timeId="${timeId}" for ${phoneNumber}`
    );

    // Ensure user exists – create if missing (e.g. user came in via templates only)
    let user = await mongoService.getUserByPhone(phoneNumber);
    if (!user) {
      logger.info(`👤 Creating new user for ${phoneNumber}`);
      user = await mongoService.createUser({
        phone_number: phoneNumber,
        status: "active",
        timezone: undefined,
        location: undefined,
        gender: undefined,
      });
    }
    if (!user || !user.id) {
      throw new Error(`User not found or missing ID for ${phoneNumber}`);
    }

    logger.info(`✅ User found: ${phoneNumber}, user_id: ${user.id}`);

    const timeOffsetMap: Record<string, number> = {
      "10": -10,
      "20": -20,
      "30": -30,
      "45": -45,
      "60": -60,
    };

    const timeOffsetMinutes = timeOffsetMap[timeId] ?? 0;
    logger.info(
      `⏰ Mapped timeId "${timeId}" to offset ${timeOffsetMinutes} minutes`
    );

    const reminderData = {
      user_id: user.id,
      reminder_type: reminderType,
      enabled: true,
      time_offset_minutes: timeOffsetMinutes,
    };

    logger.info(`💾 Saving reminder to DB:`, reminderData);
    const savedReminder = await mongoService.upsertReminderSetting(reminderData);
    logger.info(`✅ Reminder saved successfully:`, savedReminder);

    state.creatingReminderType.delete(phoneNumber);

    // Send confirmation
    const typeNames: Record<ReminderType, string> = {
      tefillin: "הנחת תפילין",
      candle_lighting: "הדלקת נרות",
      shema: "זמן קריאת שמע",
      taara: "הפסק טהרה",
      clean_7: "שבעה נקיים",
    };

    const timeDescriptions: Record<string, string> = {
      "10": "10 דקות לפני",
      "20": "20 דקות לפני",
      "30": "30 דקות לפני",
      "45": "45 דקות לפני",
      "60": "שעה לפני",
    };

    logger.info(
      `✅ Reminder saved: ${reminderType} with offset ${timeOffsetMinutes} minutes for ${phoneNumber}`
    );

    // Send completion template - if template fails, send simple text confirmation instead
    try {
      if (config.templates.complete && config.templates.complete.trim() !== "") {
        await twilioService.sendTemplateMessage(phoneNumber, "complete");
      } else {
        // Send simple text confirmation if no template is configured
        const typeName = typeNames[reminderType] || "תזכורת";
        const timeDesc = timeDescriptions[timeId] || `${Math.abs(timeOffsetMinutes)} דקות לפני`;
        await twilioService.sendMessage(
          phoneNumber,
          `✅ תודה רבה! התזכורת נשמרה במערכת.\n\nסוג: ${typeName}\nזמן: ${timeDesc}`
        );
      }
    } catch (templateError) {
      // Template failed, but reminder is saved - send simple text confirmation
      logger.warn(`Template send failed for ${phoneNumber}, sending text confirmation instead:`, templateError);
      const typeName = typeNames[reminderType] || "תזכורת";
      const timeDesc = timeDescriptions[timeId] || `${Math.abs(timeOffsetMinutes)} דקות לפני`;
      await twilioService.sendMessage(
        phoneNumber,
        `✅ תודה רבה! התזכורת נשמרה במערכת.\n\nסוג: ${typeName}\nזמן: ${timeDesc}`
      );
    }
  } catch (error) {
    logger.error(`Error saving reminder for ${phoneNumber}:`, error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ שגיאה בשמירת התזכורת. נסה שוב."
    );
  }
}

/**
 * Saves candle lighting reminder with location and time option
 */
export async function saveCandleLightingReminder(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  city: string | null,
  timeOption?: string
): Promise<void> {
  try {
    // Ensure user exists – create if missing
    let user = await mongoService.getUserByPhone(phoneNumber);
    if (!user) {
      user = await mongoService.createUser({
        phone_number: phoneNumber,
        status: "active",
        timezone: undefined,
        location: undefined,
        gender: undefined,
      });
    }
    if (!user.id) {
      throw new Error("User not found");
    }

    // Update user location if city was provided
    if (city) {
      await mongoService.updateUser(phoneNumber, { location: city });
    }

    // Map time option to offset minutes
    // morning = 8:00 AM (0 offset, special handling in scheduler)
    // one_hour = 1 hour before Shabbat (-60 minutes)
    // two_hours = 2 hours before Shabbat (-120 minutes)
    const timeOffsetMap: Record<string, number> = {
      morning: 0,
      one_hour: -60,
      two_hours: -120,
    };
    const timeOffsetMinutes = timeOption ? (timeOffsetMap[timeOption] ?? 0) : 0;

    // Save reminder
    await mongoService.upsertReminderSetting({
      user_id: user.id,
      reminder_type: "candle_lighting",
      enabled: true,
      time_offset_minutes: timeOffsetMinutes,
    });

    state.creatingReminderType.delete(phoneNumber);

    logger.info(
      `✅ Candle lighting reminder saved for ${phoneNumber} with city: ${city}`
    );

    // Send completion template: {{1}} עיר, {{2}} כניסת שבת, {{3}} זמן התזכורת
    try {
      const location = city || user.location || "Jerusalem";
      const { time: candleTime } =
        await hebcalService.getNextCandleLightingTime(location);
      const reminderTime =
        timeOffsetMinutes === 0
          ? "08:00"
          : candleTime
            ? timezoneService.calculateReminderTime(candleTime, timeOffsetMinutes)
            : "08:00";
      const finalMessageKey =
        user.gender === "female" && config.templates.candleLightingFinalMessageWomen?.trim()
          ? "candleLightingFinalMessageWomen"
          : "candleLightingFinalMessage";
      if (config.templates[finalMessageKey as keyof typeof config.templates]?.trim()) {
        await twilioService.sendTemplateMessage(
          phoneNumber,
          finalMessageKey as "candleLightingFinalMessage" | "candleLightingFinalMessageWomen",
          {
            "1": location,
            "2": candleTime || "18:00",
            "3": reminderTime,
          }
        );
      } else if (config.templates.complete && config.templates.complete.trim() !== "") {
        await twilioService.sendTemplateMessage(phoneNumber, "complete");
      } else {
        // Send simple text confirmation if no template is configured
        const cityName = getCityNameInHebrew(city);
        const timeDesc = timeOption === "morning" ? "8:00" :
          timeOption === "one_hour" ? "שעה לפני שבת" :
            timeOption === "two_hours" ? "שעתיים לפני שבת" : "לפני שבת";
        await twilioService.sendMessage(
          phoneNumber,
          `✅ תודה רבה! התזכורת נשמרה במערכת.\n\nסוג: הדלקת נרות שבת\nעיר: ${cityName}\nזמן: ${timeDesc}`
        );
      }
    } catch (templateError) {
      // Template failed, but reminder is saved - send simple text confirmation
      logger.warn(`Template send failed for ${phoneNumber}, sending text confirmation instead:`, templateError);
      const cityName = getCityNameInHebrew(city);
      const timeDesc = timeOption === "morning" ? "8:00" :
        timeOption === "one_hour" ? "שעה לפני שבת" :
          timeOption === "two_hours" ? "שעתיים לפני שבת" : "לפני שבת";
      await twilioService.sendMessage(
        phoneNumber,
        `✅ תודה רבה! התזכורת נשמרה במערכת.\n\nסוג: הדלקת נרות שבת\nעיר: ${cityName}\nזמן: ${timeDesc}`
      );
    }
  } catch (error) {
    logger.error(
      `Error saving candle lighting reminder for ${phoneNumber}:`,
      error
    );
    await twilioService.sendMessage(
      phoneNumber,
      "❌ שגיאה בשמירת התזכורת. נסה שוב."
    );
  }
}

/**
 * Women's flow: save Hefsek Tahara reminder.
 * Currently stores the chosen time-of-day as both offset from midnight and test_time
 * so that future schedulers can use it.
 */
export async function saveTaaraReminder(
  phoneNumber: string,
  timeOfDay: string | null
): Promise<void> {
  try {
    // Ensure user exists – create if missing
    let user = await mongoService.getUserByPhone(phoneNumber);
    if (!user) {
      user = await mongoService.createUser({
        phone_number: phoneNumber,
        status: "active",
        timezone: undefined,
        location: undefined,
        gender: undefined,
      });
    }
    if (!user.id) {
      throw new Error("User not found");
    }

    // Convert HH:MM to minutes from midnight (offset from 00:00)
    const offsetMinutes = parseTimeOfDayToMinutes(timeOfDay);

    await mongoService.upsertReminderSetting({
      user_id: user.id,
      reminder_type: "taara",
      enabled: true,
      time_offset_minutes: offsetMinutes,
      test_time: timeOfDay || undefined,
    });

    logger.info(
      `✅ Tahara reminder saved for ${phoneNumber} at ${timeOfDay} (offsetMinutes=${offsetMinutes})`
    );
  } catch (error) {
    logger.error(
      `Error saving tahara reminder for ${phoneNumber}:`,
      error
    );
    await twilioService.sendMessage(
      phoneNumber,
      "❌ שגיאה בשמירת תזכורת הפסק טהרה. נסה שוב."
    );
  }
}

/**
 * Disable taara reminder when user presses "לעצירת התזכורת לחצי" (stop_the_remainder).
 */
export async function disableTaaraReminder(phoneNumber: string): Promise<void> {
  try {
    const user = await mongoService.getUserByPhone(phoneNumber);
    if (!user?.id) return;
    const settings = await mongoService.getReminderSettings(user.id);
    const taara = settings.find((s) => s.reminder_type === "taara");
    if (taara?.id) {
      await mongoService.updateReminderSettingById(taara.id, { enabled: false });
      logger.info(`Tahara reminder disabled for ${phoneNumber}`);
    }
  } catch (error) {
    logger.error(`Error disabling taara reminder for ${phoneNumber}:`, error);
  }
}

/**
 * Women's flow: save 7 clean-days reminder.
 * Sends daily at 09:00; clean_7_start_date is day 1. Template {{1}} should be the full Hebrew body from buildClean7ReminderText.
 * @param startDate YYYY-MM-DD in Israel timezone (default: today)
 */
export async function saveClean7Reminder(
  phoneNumber: string,
  startDate?: string
): Promise<void> {
  try {
    let user = await mongoService.getUserByPhone(phoneNumber);
    if (!user) {
      user = await mongoService.createUser({
        phone_number: phoneNumber,
        status: "active",
        timezone: undefined,
        location: undefined,
        gender: undefined,
      });
    }
    if (!user.id) {
      throw new Error("User not found");
    }

    const start = startDate || timezoneService.getDateInTimezone(ISRAEL_TZ);
    const timeOfDay = "09:00";
    const offsetMinutes = parseTimeOfDayToMinutes(timeOfDay);

    await mongoService.upsertReminderSetting({
      user_id: user.id,
      reminder_type: "clean_7",
      enabled: true,
      time_offset_minutes: offsetMinutes,
      test_time: timeOfDay,
      clean_7_start_date: start,
    });

    logger.info(
      `✅ 7-clean-days reminder saved for ${phoneNumber} at ${timeOfDay}, start_date=${start}`
    );
  } catch (error) {
    logger.error(
      `Error saving 7-clean-days reminder for ${phoneNumber}:`,
      error
    );
    await twilioService.sendMessage(
      phoneNumber,
      "❌ שגיאה בשמירת תזכורת שבעה נקיים. נסה שוב."
    );
  }
}

/**
 * Updates existing reminder from time picker
 */
export async function updateReminderFromTimePicker(
  phoneNumber: string,
  reminderId: string,
  timeId: string,
  reminderType: ReminderType
): Promise<void> {
  try {
    // Ensure user exists – create if missing
    let user = await mongoService.getUserByPhone(phoneNumber);
    if (!user) {
      user = await mongoService.createUser({
        phone_number: phoneNumber,
        status: "active",
        timezone: undefined,
        location: undefined,
        gender: undefined,
      });
    }
    if (!user.id) {
      throw new Error("User not found");
    }

    const timeOffsetMap: Record<string, number> = {
      "10": -10,
      "20": -20,
      "30": -30,
      "45": -45,
      "60": -60,
    };

    const timeOffsetMinutes = timeOffsetMap[timeId] ?? 0;

    await mongoService.upsertReminderSetting({
      user_id: user.id,
      reminder_type: reminderType,
      enabled: true,
      time_offset_minutes: timeOffsetMinutes,
    });

    const typeNames: Record<ReminderType, string> = {
      tefillin: "הנחת תפילין",
      candle_lighting: "הדלקת נרות",
      shema: "זמן קריאת שמע",
      taara: "הפסק טהרה",
      clean_7: "שבעה נקיים",
    };

    await twilioService.sendMessage(
      phoneNumber,
      `✅ התזכורת עודכנה בהצלחה!\n\n📌 סוג: ${typeNames[reminderType]}`
    );

    logger.debug(`Reminder ${reminderId} updated for ${phoneNumber}`);
  } catch (error) {
    logger.error(
      `Error updating reminder ${reminderId} for ${phoneNumber}:`,
      error
    );
    await twilioService.sendMessage(
      phoneNumber,
      "❌ שגיאה בעדכון התזכורת. נסה שוב."
    );
  }
}
