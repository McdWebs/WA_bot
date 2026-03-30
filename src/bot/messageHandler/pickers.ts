import hebcalService from "../../services/hebcal";
import mongoService from "../../services/mongo";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import timezoneService from "../../utils/timezone";
import { config } from "../../config";
import type { ReminderType } from "../../types";
import { inferLocationFromPhoneNumber } from "./pure/inferLocationFromPhoneNumber";
import type { MessageHandlerMutableState } from "./state";
import { ISRAEL_TZ } from "./state";

/**
 * Sends time picker for tefillin reminder
 * If locationOverride is provided (from city picker), use it; otherwise use user.location / inferred city.
 */
export async function sendTefilinTimePicker(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  locationOverride?: string
): Promise<void> {
  try {
    logger.debug(`Sending tefillin time picker to ${phoneNumber}`);
    state.creatingReminderType.set(phoneNumber, "tefillin");

    // Determine base location: prefer explicit override, then saved user.location, then inferred city
    const user = await mongoService.getUserByPhone(phoneNumber);
    const baseLocation =
      locationOverride ||
      (user && user.location) ||
      inferLocationFromPhoneNumber(phoneNumber);

    logger.info(
      `📍 Tefilin time picker - Location determined: "${baseLocation}" for ${phoneNumber}`
    );

    // Get sunset time for that location from Hebcal
    const sunsetData = await hebcalService.getSunsetData(baseLocation);
    const sunsetTime = sunsetData?.sunset || "18:00";

    logger.info(
      `⏰ Tefilin time picker - Sunset time retrieved: "${sunsetTime}" for location "${baseLocation}"`
    );

    // The WhatsApp template has a variable whose default is 5:45.
    // We override it by passing the actual sunset time as a content variable.
    // To be safe with numbering, we send it as both {{1}} and {{2}}.
    const templateVariables: Record<string, string> = {
      "1": sunsetTime,
      "2": sunsetTime,
    };

    logger.info(
      `📤 Sending tefillin time picker template with variables {{1}}="${sunsetTime}", {{2}}="${sunsetTime}" to ${phoneNumber}`
    );

    await twilioService.sendTemplateMessage(
      phoneNumber,
      "tefillinTimePicker",
      templateVariables
    );
    logger.info(
      `✅ Tefilin time picker template sent to ${phoneNumber} with sunset ${sunsetTime} for location ${baseLocation}`
    );
  } catch (error) {
    logger.error(
      `Error sending tefillin time picker to ${phoneNumber}:`,
      error
    );
    // Fallback
    await twilioService.sendMessage(
      phoneNumber,
      "כמה זמן לפני השקיעה?\n\n1. 10 דקות\n2. 30 דקות\n3. 1 שעה"
    );
  }
}

/**
 * Sends city picker with reminder type selection
 */
export async function sendCityPicker(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  reminderType?: ReminderType
): Promise<void> {
  try {
    if (reminderType) {
      state.lastCityPickerContext.set(phoneNumber, reminderType);
    } else {
      state.lastCityPickerContext.set(phoneNumber, "settings");
    }

    logger.debug(`Sending city picker to ${phoneNumber} for reminder type: ${reminderType}`);

    // Map reminder type to Hebrew text for variable {{1}}
    const reminderTypeNames: Record<ReminderType, string> = {
      tefillin: "הנחת תפילין",
      candle_lighting: "הדלקת נרות שבת",
      shema: "זמן קריאת שמע",
      taara: "הפסק טהרה",
      clean_7: "שבעה נקיים",
    };

    const reminderTypeText = reminderType
      ? reminderTypeNames[reminderType] || "תזכורת"
      : "תזכורת";

    // For List Picker template, we only need to pass variable {{1}} for the reminder type
    // The list items are defined in the template itself
    const templateVariables: Record<string, string> = {
      "1": reminderTypeText,
    };

    await twilioService.sendTemplateMessage(
      phoneNumber,
      "cityPicker",
      templateVariables
    );
    logger.debug(`City picker sent to ${phoneNumber}`);
  } catch (error) {
    logger.error(`Error sending city picker to ${phoneNumber}:`, error);
    // Fallback
    await twilioService.sendMessage(
      phoneNumber,
      "איזה עיר?\n\n1. ירושלים\n2. באר שבע\n3. תל אביב\n4. אילת\n5. חיפה\n\n6. *אחר* — שלחו 6 ואז *מיקום* מווטסאפ (📎 ← מיקום)."
    );
  }
}

/**
 * Women's flow: send tahara time-picker template; bot receives sunset time (for display in template).
 */
export async function sendTaaraTimePicker(phoneNumber: string): Promise<void> {
  try {
    const user = await mongoService.getUserByPhone(phoneNumber);
    const location = user?.location || inferLocationFromPhoneNumber(phoneNumber);
    const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
    const sunsetTime = await hebcalService.getSunsetTime(location, todayStr) || "18:00";
    await twilioService.sendTemplateMessage(phoneNumber, "taaraTimePicker", {
      "1": sunsetTime,
    });
    logger.debug(`Taara time picker sent to ${phoneNumber} with sunset ${sunsetTime}`);
  } catch (error) {
    logger.error(`Error sending taara time picker to ${phoneNumber}:`, error);
    await twilioService.sendMessage(
      phoneNumber,
      "לא הצלחתי לשלוח תפריט בחירת שעה. נסי שוב."
    );
  }
}

/**
 * Sends time picker for candle lighting reminder
 */
export async function sendCandleLightingTimePicker(phoneNumber: string): Promise<void> {
  try {
    logger.debug(`Sending candle lighting time picker to ${phoneNumber}`);
    // Get user's location to fetch candle lighting time
    const user = await mongoService.getUserByPhone(phoneNumber);
    const location = user?.location || "Jerusalem";

    // Get the next available candle lighting time (closest upcoming Shabbat)
    const { time: candleLightingTime, date } =
      await hebcalService.getNextCandleLightingTime(location);

    if (!candleLightingTime) {
      logger.warn(
        `No upcoming candle lighting time found for ${location}, using fallback`
      );
      await twilioService.sendMessage(
        phoneNumber,
        "מתי לתזכר אותך?\n\n1. 8:00\n2. שעה לפני שבת\n3. שעתיים לפני שבת"
      );
      return;
    }

    // Format time as HH:MM for template variable {{1}}
    const [hours, minutes] = candleLightingTime.split(":").map(Number);
    const formattedTime = `${String(hours).padStart(2, "0")}:${String(
      minutes
    ).padStart(2, "0")}`;

    logger.info(
      `📤 Sending candle lighting time picker with candle time ${formattedTime} for location ${location} on date ${date} to ${phoneNumber}`
    );

    // Use women's template for female users, default for others
    const timePickerKey =
      user?.gender === "female" && config.templates.candleLightingTimePickerWomen?.trim()
        ? "candleLightingTimePickerWomen"
        : "candleLightingTimePicker";
    await twilioService.sendTemplateMessage(phoneNumber, timePickerKey, {
      "1": formattedTime,
    });
    logger.debug(`Candle lighting time picker sent to ${phoneNumber}`);
  } catch (error) {
    logger.error(
      `Error sending candle lighting time picker to ${phoneNumber}:`,
      error
    );
    // Fallback
    await twilioService.sendMessage(
      phoneNumber,
      "מתי לתזכר אותך?\n\n1. 8:00\n2. שעה לפני שבת\n3. שעתיים לפני שבת"
    );
  }
}

/**
 * Sends time picker for shema reminder
 */
export async function sendShemaTimePicker(
  state: MessageHandlerMutableState,
  phoneNumber: string
): Promise<void> {
  try {
    logger.debug(`Sending shema time picker to ${phoneNumber}`);
    state.creatingReminderType.set(phoneNumber, "shema");

    // Determine base location: use user's saved location if available, otherwise infer from phone
    const user = await mongoService.getUserByPhone(phoneNumber);
    const baseLocation =
      (user && user.location) ||
      inferLocationFromPhoneNumber(phoneNumber);

    // Get Shema time for that location from Hebcal
    const shemaTime =
      (await hebcalService.getShemaTime(baseLocation)) || "09:00";

    // For shematimepicker_v2 we only need one variable: {{1}} = shemaTime
    const templateVariables: Record<string, string> = {
      "1": shemaTime,
    };

    await twilioService.sendTemplateMessage(
      phoneNumber,
      "shemaTimePicker",
      templateVariables
    );
    logger.debug(`Shema time picker sent to ${phoneNumber}`);
  } catch (error) {
    logger.error(`Error sending shema time picker to ${phoneNumber}:`, error);
    // Fallback
    await twilioService.sendMessage(
      phoneNumber,
      "כמה זמן לפני?\n\n1. 10 דקות\n2. 30 דקות\n3. 1 שעה לפני"
    );
  }
}

export async function sendTimePickerForSunset(
  phoneNumber: string,
  location: string
): Promise<void> {
  try {
    logger.debug(`Preparing time picker for ${phoneNumber}, location: ${location}`);

    // Validate location - if it's invalid or too short, infer from phone number
    let validLocation = location;
    if (!location || location.length < 2 || location.length > 50) {
      logger.warn(
        `Invalid location "${location}", inferring from phone number`
      );
      validLocation = inferLocationFromPhoneNumber(phoneNumber);
    }

    // Try to get sunset data with the location
    let sunsetData = await hebcalService.getSunsetData(validLocation);

    // If that fails, try with inferred location from phone number (if different)
    if (!sunsetData) {
      const inferredLocation = inferLocationFromPhoneNumber(phoneNumber);
      if (inferredLocation !== validLocation) {
        logger.debug(`Trying inferred location "${inferredLocation}" as fallback`);
        sunsetData = await hebcalService.getSunsetData(inferredLocation);
        if (sunsetData) {
          validLocation = inferredLocation;
        }
      }

      // Final fallback to Jerusalem if still no data
      if (!sunsetData && validLocation !== "Jerusalem") {
        logger.info(`Trying "Jerusalem" as final fallback`);
        sunsetData = await hebcalService.getSunsetData("Jerusalem");
        if (sunsetData) {
          validLocation = "Jerusalem";
        }
      }
    }

    if (!sunsetData) {
      logger.warn(`No sunset data found for location: ${validLocation}`);
      await twilioService.sendMessage(
        phoneNumber,
        "Sorry, I could not retrieve sunset time for your location. Please try again later."
      );
      return;
    }

    // Prepare template variables for List Picker template
    // The template has 5 list items, each with: name ({{1,4,7,10,13}}), id ({{2,5,8,11,14}}), description ({{3,6,9,12,15}})
    // We'll create time options based on the sunset time
    const sunsetTime = sunsetData.sunset || "18:00";
    const [hours, minutes] = sunsetTime.split(":").map(Number);

    // Helper function to calculate time before sunset
    const calculateTimeBefore = (minutesBefore: number): string => {
      const totalMinutes = hours * 60 + minutes;
      let reminderMinutes = totalMinutes - minutesBefore;

      // Handle negative time (crossing midnight)
      if (reminderMinutes < 0) {
        reminderMinutes = 24 * 60 + reminderMinutes; // Add 24 hours
      }

      const reminderHours = Math.floor(reminderMinutes / 60) % 24; // Ensure hours stay in 0-23 range
      const reminderMins = reminderMinutes % 60;

      const result = `${String(reminderHours).padStart(2, "0")}:${String(
        reminderMins
      ).padStart(2, "0")}`;
      logger.info(
        `Calculated time: ${sunsetTime} - ${minutesBefore} minutes = ${result}`
      );
      return result;
    };

    // Create time options (at sunset, 15 min before, 30 min before, 45 min before, 1 hour before)
    const timeOptions = [
      {
        name: `בזמן השקיעה (${sunsetTime})`,
        id: "0",
        desc: `תזכורת בדיוק בזמן השקיעה`,
      },
      {
        name: `15 דקות לפני (${calculateTimeBefore(15)})`,
        id: "15",
        desc: `תזכורת 15 דקות לפני השקיעה`,
      },
      {
        name: `30 דקות לפני (${calculateTimeBefore(30)})`,
        id: "30",
        desc: `תזכורת 30 דקות לפני השקיעה`,
      },
      {
        name: `45 דקות לפני (${calculateTimeBefore(45)})`,
        id: "45",
        desc: `תזכורת 45 דקות לפני השקיעה`,
      },
      {
        name: `שעה לפני (${calculateTimeBefore(60)})`,
        id: "60",
        desc: `תזכורת שעה לפני השקיעה`,
      },
    ];

    // Populate all 15 variables (5 items × 3 fields each)
    // Item 1: {{1}}=name, {{2}}=id, {{3}}=description
    // Item 2: {{4}}=name, {{5}}=id, {{6}}=description
    // Item 3: {{7}}=name, {{8}}=id, {{9}}=description
    // Item 4: {{10}}=name, {{11}}=id, {{12}}=description
    // Item 5: {{13}}=name, {{14}}=id, {{15}}=description
    const templateVariables: Record<string, string> = {};
    timeOptions.forEach((option, index) => {
      const baseVar = index * 3 + 1; // 1, 4, 7, 10, 13
      templateVariables[String(baseVar)] = option.name; // Item name
      templateVariables[String(baseVar + 1)] = option.id; // Item ID
      templateVariables[String(baseVar + 2)] = option.desc; // Item description
    });

    // Send formatted plain text message with time options
    const formattedMessage =
      `🌅 זמני השקיעה\n\n` +
      `📍 מיקום: ${validLocation}\n` +
      `📅 תאריך: ${sunsetData.date}\n` +
      `⏰ שקיעה: ${sunsetData.sunset}\n\n` +
      `בחר זמן לתזכורת:\n` +
      `1. בזמן השקיעה (${sunsetData.sunset})\n` +
      `2. 15 דקות לפני (${calculateTimeBefore(15)})\n` +
      `3. 30 דקות לפני (${calculateTimeBefore(30)})\n` +
      `4. 45 דקות לפני (${calculateTimeBefore(45)})\n` +
      `5. שעה לפני (${calculateTimeBefore(60)})`;

    await twilioService.sendMessage(phoneNumber, formattedMessage);
    logger.info(`Sent time picker options as text message to ${phoneNumber}`);
  } catch (error) {
    logger.error(
      `Error sending time picker for sunset to ${phoneNumber}:`,
      error
    );
    throw error;
  }
}

/**
 * Sends appropriate time picker based on reminder type
 */
export async function sendTimePickerForReminderType(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  reminderType: ReminderType,
  location?: string
): Promise<void> {
  if (reminderType === "tefillin") {
    await sendTefilinTimePicker(state, phoneNumber, location);
  } else if (reminderType === "shema") {
    await sendShemaTimePicker(state, phoneNumber);
  } else if (reminderType === "candle_lighting") {
    // Candle lighting doesn't use time picker, but if editing, we might need to handle it
    await twilioService.sendMessage(
      phoneNumber,
      "תזכורת הדלקת נרות נשלחת כל יום שישי ב-8:00 בבוקר. אין צורך לבחור זמן."
    );
  } else {
    // Fallback: use sunset time picker
    await sendTimePickerForSunset(phoneNumber, location || "Jerusalem");
  }
}
