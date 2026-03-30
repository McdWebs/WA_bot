import mongoService from "../../services/mongo";
import hebcalService from "../../services/hebcal";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import { Gender, ReminderType } from "../../types";
import reminderService from "../../services/reminderService";
import reminderStateManager, { ReminderStateMode } from "../../services/reminderStateManager";
import settingsStateManager from "../../services/settingsStateManager";
import timezoneService from "../../utils/timezone";
import {
  completeLocationSelection,
  continueReminderFlowWithSavedLocation,
} from "./locationFlow";
import { sendMainMenu, sendManageRemindersMenu } from "./menus";
import {
  sendCityPicker,
  sendTimePickerForReminderType,
  sendTimePickerForSunset,
} from "./pickers";
import {
  disableTaaraReminder,
  saveCandleLightingReminder,
  saveClean7Reminder,
  saveReminderFromTimePicker,
  saveTaaraReminder,
} from "./persistence";
import { inferLocationFromPhoneNumber } from "./pure/inferLocationFromPhoneNumber";
import { isCustomLocationButton } from "./pure/isCustomLocationButton";
import {
  isTahara30MinOption,
  isTahara60MinOption,
  isTaharaMorningOption,
  isTaharaTimePickerButton,
} from "./pure/taharaButtonGuards";
import { subtractMinutesFromTime } from "./pure/time";
import { getCreatingReminderType } from "./stateAccess";
import type { MessageHandlerMutableState } from "./state";
import { ISRAEL_TZ } from "./state";

export async function interactiveButtonFlow(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  buttonIdentifier: string
): Promise<void> {
  try {
    // Any interactive button click moves the user into a non-settings flow.
    // Clear settings state so the conversation doesn't stay "stuck" in settings.
    settingsStateManager.clearState(phoneNumber);

    logger.info(
      `🔘 Handling interactive button click from ${phoneNumber}: "${buttonIdentifier}"`
    );

    // CRITICAL: Only process if this is a valid button identifier
    // Reject empty or invalid identifiers to prevent accidental triggers
    if (!buttonIdentifier || buttonIdentifier.trim().length === 0) {
      logger.warn(
        `⚠️ Invalid button identifier - ignoring: "${buttonIdentifier}"`
      );
      return;
    }

    // Get user data
    const user = await mongoService.getUserByPhone(phoneNumber);
    if (!user) {
      logger.warn(
        `User ${phoneNumber} not found - cannot handle button click`
      );
      return;
    }

    // Normalize button identifier
    const normalizedButton = buttonIdentifier.toLowerCase().trim();
    const cleanButton = normalizedButton
      .replace(/^[1-9][\.:]\s*/, "")
      .replace(/^[1-9]\s*/, "");

    logger.info(
      `🔍 Button parsing for ${phoneNumber}: original="${buttonIdentifier}", normalized="${normalizedButton}", clean="${cleanButton}"`
    );

    // Check creatingReminderType BEFORE processing
    const creatingReminderTypeForLog = getCreatingReminderType(state, phoneNumber);
    logger.info(
      `📋 Current creatingReminderType for ${phoneNumber}: "${creatingReminderTypeForLog}"`
    );

    // Check if this is a gender selection (from gender question template)
    // Single, clear IDs per option
    const isGenderSelection =
      normalizedButton === "male" ||
      normalizedButton === "female" ||
      normalizedButton === "prefer_not_to_say";

    // Women's flows – tahara / 7 clean days
    const isTaaraMenuSelection =
      normalizedButton === "taara_stop" ||
      normalizedButton === "taara" ||
      normalizedButton === "hefsek_tahara";

    const isClean7MenuSelection =
      normalizedButton === "clean_7" ||
      normalizedButton === "clean7" ||
      normalizedButton === "seven_clean" ||
      normalizedButton === "7_clean";

    const isTaaraPlusClean7MenuSelection =
      normalizedButton === "taara_plus_clean7" ||
      normalizedButton === "taara_clean7" ||
      (normalizedButton.includes("taara") &&
        (normalizedButton.includes("7") || normalizedButton.includes("clean")));

    // Check if this is a main menu selection (reminder type)
    // Candle lighting: accept same payload from main menu and from woman menu (e.g. candle_lighting_woman, candel_time, shabbat_candles)
    const isCandleLightingSelection =
      normalizedButton === "candle_lighting" ||
      normalizedButton === "candle_lighting_woman" ||
      normalizedButton === "candel_time" ||
      normalizedButton === "candle_time" ||
      normalizedButton === "shabbat_candles" ||
      normalizedButton === "candles" ||
      (normalizedButton.includes("candle") && !normalizedButton.includes("edit")) ||
      (normalizedButton.includes("candel") && !normalizedButton.includes("edit"));
    const isMainMenuSelection =
      normalizedButton === "tefillin" ||
      isCandleLightingSelection ||
      normalizedButton === "shema";

    // Check if this is from the "manage reminders" menu or button
    const isManageRemindersAction =
      normalizedButton === "manage_reminders" ||
      normalizedButton === "show_reminders" ||
      normalizedButton === "reminders" ||
      normalizedButton === "add_reminder" ||
      normalizedButton === "close_menu";

    // Check if this is an edit button from reminders list (format: "edit_<reminder_id>")
    const isEditReminderButton = normalizedButton.startsWith("edit_");

    // Check if this is a time selection from a time picker template
    // For tefillin: "10", "30", "60" (minutes before)
    // For shema: "10", "30", "60" (minutes before)
    // Also check cleanButton in case there's formatting like "1. 10" or "10."
    // Also check original buttonIdentifier in case normalization changed it
    const isTimePickerSelection =
      normalizedButton === "30" ||
      normalizedButton === "45" ||
      normalizedButton === "60" ||
      normalizedButton === "morning" ||
      normalizedButton === "one_hour" ||
      normalizedButton === "two_hours" ||
      normalizedButton === "10" ||
      normalizedButton === "20" ||
      cleanButton === "30" ||
      cleanButton === "45" ||
      cleanButton === "60" ||
      cleanButton === "10" ||
      cleanButton === "20" ||
      /^(10|20|30|45|60)$/.test(normalizedButton) ||
      /^(10|20|30|45|60)$/.test(cleanButton) ||
      /^(10|20|30|45|60)$/.test(buttonIdentifier.trim());

    logger.info(
      `⏰ Time picker check for ${phoneNumber}: isTimePickerSelection=${isTimePickerSelection}, button="${buttonIdentifier}", normalized="${normalizedButton}", clean="${cleanButton}"`
    );

    // Check if this is a city selection
    const isCitySelection =
      normalizedButton === "jerusalem" ||
      normalizedButton === "beer sheva" ||
      normalizedButton === "tel aviv" ||
      normalizedButton === "eilat" ||
      normalizedButton === "haifa";

    // Time selection for tahara flows: look for explicit HH:MM in the button identifier
    const taaraTimeMatch = normalizedButton.match(/(\d{1,2}:\d{2})/);
    const isTaaraTimeSelection = !!taaraTimeMatch;

    if (isGenderSelection) {
      // User selected gender - save it and show main menu
      let gender: Gender = "prefer_not_to_say";
      if (normalizedButton === "male") {
        gender = "male";
      } else if (normalizedButton === "female") {
        gender = "female";
      }

      await mongoService.updateUser(phoneNumber, {
        gender,
        status: "active",
      });

      logger.debug(`Gender saved for ${phoneNumber}: ${gender}`);
      await sendMainMenu(phoneNumber, gender);
    } else if (isMainMenuSelection) {
      // User selected reminder type from main menu
      // For now, do NOT enforce gender-based restrictions – all users can choose any option
      if (normalizedButton === "tefillin") {
        // For tefillin, use saved location when available; otherwise ask for city
        const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
          state,
          phoneNumber,
          "tefillin"
        );
        if (!continuedWithSavedLocation) {
          state.creatingReminderType.set(phoneNumber, "tefillin");
          await sendCityPicker(state, phoneNumber, "tefillin");
        }
      } else if (isCandleLightingSelection) {
        // For candle lighting, use saved location when available; otherwise ask for city
        const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
          state,
          phoneNumber,
          "candle_lighting"
        );
        if (!continuedWithSavedLocation) {
          state.creatingReminderType.set(phoneNumber, "candle_lighting");
          await sendCityPicker(state, phoneNumber, "candle_lighting");
        }
      } else if (normalizedButton === "shema") {
        // For shema, use saved location when available; otherwise ask for city
        const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
          state,
          phoneNumber,
          "shema"
        );
        if (!continuedWithSavedLocation) {
          state.creatingReminderType.set(phoneNumber, "shema");
          await sendCityPicker(state, phoneNumber, "shema");
        }
      }
    } else if (isManageRemindersAction) {
      // Handle buttons from manage reminders quick-reply template
      if (normalizedButton === "manage_reminders") {
        // Main menu button to open the manage reminders menu
        await sendManageRemindersMenu(phoneNumber);
      } else if (
        normalizedButton === "show_reminders" ||
        normalizedButton === "reminders"
      ) {
        // Send loading message immediately for better UX
        await twilioService.sendMessage(phoneNumber, "⏳ טוען את התזכורות שלך...");
        // Use ReminderService to list reminders
        const result = await reminderService.listReminders(phoneNumber);
        if (result && result.trim() !== "") {
          await twilioService.sendMessage(phoneNumber, result);
          // State is set by ReminderService.listReminders()
        }
      } else if (normalizedButton === "add_reminder") {
        // Reuse the main menu to start a new reminder flow
        const userForGender = await mongoService.getUserByPhone(phoneNumber);
        const gender: Gender =
          (userForGender?.gender as Gender) || "prefer_not_to_say";
        await sendMainMenu(phoneNumber, gender);
      } else if (normalizedButton === "close_menu") {
        await twilioService.sendMessage(
          phoneNumber,
          "תפריט נסגר. אני כאן בשבילך! פשוט שלח לי הודעה ואני אעזור לך 😊"
        );
      }
    } else if (isEditReminderButton) {
      // User clicked "Edit" on a reminder → store reminder ID and send time picker template
      const reminderId = normalizedButton.replace("edit_", "");
      logger.info(
        `✅ Detected edit reminder button for reminder ID: ${reminderId}`
      );

      // Set state for editing
      reminderStateManager.setState(phoneNumber, {
        mode: ReminderStateMode.EDIT_REMINDER,
        reminderId,
      });

      // Get reminder to determine which time picker to send
      const reminder = await reminderService.getReminder(phoneNumber, reminderId);
      if (reminder) {
        await sendTimePickerForReminderType(
          state,
          phoneNumber,
          reminder.reminder_type,
          user.location
        );
      } else {
        // Fallback to sunset time picker
        await sendTimePickerForSunset(
          phoneNumber,
          user.location || "Jerusalem"
        );
      }
    } else if (
      state.femaleFlowMode.has(phoneNumber) &&
      isTaharaTimePickerButton(normalizedButton, cleanButton, buttonIdentifier)
    ) {
      // Women's flow: tahara time picker (8:00 / 30 min / 1 hour before sunset) – handle BEFORE generic time picker
      const mode = state.femaleFlowMode.get(phoneNumber)!;
      const userForLoc = await mongoService.getUserByPhone(phoneNumber);
      const location = userForLoc?.location || inferLocationFromPhoneNumber(phoneNumber);
      const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
      const sunsetTime = await hebcalService.getSunsetTime(location, todayStr) || "18:00";

      let timeOfDay: string;
      if (isTaharaMorningOption(normalizedButton, cleanButton, buttonIdentifier)) {
        timeOfDay = "08:00";
      } else if (isTahara30MinOption(normalizedButton, cleanButton, buttonIdentifier)) {
        timeOfDay = subtractMinutesFromTime(sunsetTime, 30);
      } else if (isTahara60MinOption(normalizedButton, cleanButton, buttonIdentifier)) {
        timeOfDay = subtractMinutesFromTime(sunsetTime, 60);
      } else {
        logger.warn(
          `Tahara time button not mapped for ${phoneNumber}: "${buttonIdentifier}"`
        );
        state.femaleFlowMode.delete(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "❌ לא זוהה זמן. אנא בחרי 8:00, 30 דקות או שעה לפני השקיעה."
        );
        return;
      }

      logger.info(
        `👩‍🧕 Tahara time selected (picker) for ${phoneNumber}: ${timeOfDay}, mode=${mode}`
      );
      await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
      await saveTaaraReminder(phoneNumber, timeOfDay);
      state.femaleFlowMode.delete(phoneNumber);

      if (mode === "taara_plus_clean7") {
        await twilioService.sendTemplateMessage(
          phoneNumber,
          "clean7StartTaaraTime",
          { "1": sunsetTime }
        );
      } else {
        await twilioService.sendTemplateMessage(
          phoneNumber,
          "taaraFinalMessage",
          { "1": sunsetTime }
        );
      }
    } else if (isTimePickerSelection) {
      // User selected time from time picker
      const reminderEditState = reminderStateManager.getState(phoneNumber);

      if (reminderEditState?.mode === ReminderStateMode.EDIT_REMINDER && reminderEditState.reminderId) {
        // Editing existing reminder - use ReminderService
        const reminder = await reminderService.getReminder(phoneNumber, reminderEditState.reminderId);
        if (reminder) {
          // Map time picker selection to offset minutes
          const timeOffsetMap: Record<string, number> = {
            "10": -10,
            "20": -20,
            "30": -30,
            "45": -45,
            "60": -60,
          };
          const offsetMinutes = timeOffsetMap[buttonIdentifier] ?? 0;

          // Send loading message for better UX
          await twilioService.sendMessage(phoneNumber, "⏳ מעדכן את התזכורת...");

          const result = await reminderService.updateReminderOffset(
            phoneNumber,
            reminderEditState.reminderId,
            offsetMinutes
          );
          await twilioService.sendMessage(phoneNumber, result);

          // Clear state
          reminderStateManager.clearState(phoneNumber);
          logger.info(
            `✅ Updated reminder ${reminderEditState.reminderId} with offset ${offsetMinutes} for ${phoneNumber}`
          );
        }
      } else {
        // Creating new reminder - need to know which type
        const creatingReminderType = getCreatingReminderType(state, phoneNumber);
        logger.info(
          `⏰ Time picker selection detected: button="${buttonIdentifier}", normalized="${normalizedButton}", creatingReminderType="${creatingReminderType}" for ${phoneNumber}`
        );
        if (creatingReminderType) {
          // Handle candle lighting time picker buttons
          if (creatingReminderType === "candle_lighting") {
            const timeOption = normalizedButton === "morning" || normalizedButton === "one_hour" || normalizedButton === "two_hours"
              ? normalizedButton
              : (cleanButton === "morning" || cleanButton === "one_hour" || cleanButton === "two_hours" ? cleanButton : null);

            if (timeOption) {
              // Get user's saved city from location
              const userForCity = await mongoService.getUserByPhone(phoneNumber);
              const city = userForCity?.location || null;

              // Send loading message for better UX
              await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
              await saveCandleLightingReminder(state, phoneNumber, city, timeOption);
            } else {
              logger.error(
                `❌ Invalid candle lighting time option: "${buttonIdentifier}" for ${phoneNumber}`
              );
              await twilioService.sendMessage(
                phoneNumber,
                "❌ שגיאה: לא זוהה זמן תקין. אנא נסה שוב."
              );
            }
          } else {
            // Extract time ID from button - try normalized first, then clean, then extract number
            let timeId = normalizedButton;
            if (!/^(10|20|30|45|60)$/.test(timeId)) {
              timeId = cleanButton;
            }
            if (!/^(10|20|30|45|60)$/.test(timeId)) {
              // Try to extract number from button identifier
              const numberMatch = buttonIdentifier.match(/\b(10|20|30|45|60)\b/);
              if (numberMatch) {
                timeId = numberMatch[1];
              }
            }

            logger.info(
              `💾 Extracted timeId: "${timeId}" from button="${buttonIdentifier}" for ${phoneNumber}`
            );

            if (/^(10|20|30|45|60)$/.test(timeId)) {
              // Send loading message for better UX
              await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
              await saveReminderFromTimePicker(
                state,
                phoneNumber,
                creatingReminderType,
                timeId
              );
            } else {
              logger.error(
                `❌ Invalid timeId extracted: "${timeId}" from button="${buttonIdentifier}" for ${phoneNumber}`
              );
              await twilioService.sendMessage(
                phoneNumber,
                "❌ שגיאה: לא זוהה זמן תקין. אנא נסה שוב."
              );
            }
          }
        } else {
          logger.warn(
            `⚠️ Time picker selection but no creatingReminderType found for ${phoneNumber}. Button: "${buttonIdentifier}"`
          );
          await twilioService.sendMessage(
            phoneNumber,
            "❌ שגיאה: לא זוהה סוג התזכורת. אנא התחל מחדש מהתפריט הראשי."
          );
        }
      }
    } else if (isTaaraMenuSelection) {
      // Women's flow: Hefsek Tahara – FIRST ask user to choose city (bot later uses sunset for that city)
      logger.info(
        `👩‍🧕 Tahara flow started (hefsek only) for ${phoneNumber}, button="${buttonIdentifier}"`
      );
      state.femaleFlowMode.set(phoneNumber, "taara");
      // Use saved location if available; otherwise ask user to choose city
      const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
        state,
        phoneNumber,
        "taara"
      );
      if (!continuedWithSavedLocation) {
        state.creatingReminderType.set(phoneNumber, "taara");
        await sendCityPicker(state, phoneNumber, "taara");
      }
    } else if (isClean7MenuSelection) {
      // Women's flow: Seven clean days – reminder by date (how many days passed); start_date = today
      logger.info(
        `👩‍🧕 7 clean days flow selected for ${phoneNumber}, button="${buttonIdentifier}"`
      );
      const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
      await saveClean7Reminder(phoneNumber, todayStr);
      await twilioService.sendTemplateMessage(phoneNumber, "clean7FinalMessage", {
        "1": "1",
      });
    } else if (isTaaraPlusClean7MenuSelection) {
      // Women's flow: Hefsek + 7 clean days – FIRST ask for city, then hefsek time picker, then CLEAN_7_START_TAARA_TIME
      logger.info(
        `👩‍🧕 Tahara + 7 clean days flow started for ${phoneNumber}, button="${buttonIdentifier}"`
      );
      state.femaleFlowMode.set(phoneNumber, "taara_plus_clean7");
      const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
        state,
        phoneNumber,
        "taara"
      );
      if (!continuedWithSavedLocation) {
        state.creatingReminderType.set(phoneNumber, "taara");
        await sendCityPicker(state, phoneNumber, "taara");
      }
    } else if (
      normalizedButton === "start_7_clean" ||
      normalizedButton === "activate_clean7" ||
      normalizedButton === "activate_clean_7" ||
      (normalizedButton.includes("activate") && normalizedButton.includes("clean"))
    ) {
      // User pressed "להתחיל 7 נקיים" in CLEAN_7_START_TAARA_TIME template → activate 7 clean days
      logger.info(
        `👩‍🧕 Activate 7 clean days for ${phoneNumber}, button="${buttonIdentifier}"`
      );
      const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
      await saveClean7Reminder(phoneNumber, todayStr);
      await twilioService.sendTemplateMessage(phoneNumber, "clean7FinalMessage", {
        "1": "1",
      });
    } else if (
      normalizedButton === "stop_the_remainder" ||
      normalizedButton === "stop_reminder" ||
      normalizedButton.includes("stop")
    ) {
      // User pressed "לעצירת התזכורת לחצי" → disable taara reminder
      logger.info(
        `👩‍🧕 Stop taara reminder for ${phoneNumber}, button="${buttonIdentifier}"`
      );
      await disableTaaraReminder(phoneNumber);
      await twilioService.sendMessage(
        phoneNumber,
        "התזכורת להפסק טהרה הופסקה."
      );
    } else if (
      state.lastCityPickerContext.has(phoneNumber) &&
      isCustomLocationButton(
        normalizedButton,
        cleanButton,
        buttonIdentifier
      )
    ) {
      // Meta: add a list row to cityPicker with payload e.g. custom_location (see isCustomLocationButton)
      const flowContext: ReminderType | "settings" =
        state.lastCityPickerContext.get(phoneNumber) ??
        getCreatingReminderType(state, phoneNumber) ??
        "settings";
      state.lastCityPickerContext.set(phoneNumber, flowContext);
      state.awaitingCustomLocation.add(phoneNumber);
      await twilioService.sendMessage(
        phoneNumber,
        "📍 שלחו *מיקום* מווטסאפ (📎 ← מיקום) — התזכורות יחושבו לפי נקודה זו."
      );
    } else if (isTaaraTimeSelection) {
      // User chose a concrete time (HH:MM) in the tahara time-picker template
      const timeOfDay = taaraTimeMatch![1];
      const mode = state.femaleFlowMode.get(phoneNumber) || "taara";

      // Allow cancel buttons as a safety net
      if (
        normalizedButton.includes("cancel") ||
        normalizedButton.includes("ביטול")
      ) {
        logger.info(
          `👩‍🧕 Tahara flow cancelled by user ${phoneNumber}, button="${buttonIdentifier}"`
        );
        state.femaleFlowMode.delete(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "התזכורת להפסק טהרה בוטלה."
        );
      } else {
        logger.info(
          `👩‍🧕 Tahara time selected for ${phoneNumber}: ${timeOfDay}, mode=${mode}`
        );
        const userForSunset = await mongoService.getUserByPhone(phoneNumber);
        const location = userForSunset?.location || inferLocationFromPhoneNumber(phoneNumber);
        const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
        const sunsetTime = await hebcalService.getSunsetTime(location, todayStr) || "18:00";

        // Always save hefsek tahara reminder
        await saveTaaraReminder(phoneNumber, timeOfDay);
        state.femaleFlowMode.delete(phoneNumber);

        if (mode === "taara_plus_clean7") {
          // Combined flow: CLEAN_7_START_TAARA_TIME with {{1}} = sunset only; button start_7_clean
          await twilioService.sendTemplateMessage(
            phoneNumber,
            "clean7StartTaaraTime",
            { "1": sunsetTime }
          );
        } else {
          // Tahara only: final template has only {{1}} = sunset
          await twilioService.sendTemplateMessage(
            phoneNumber,
            "taaraFinalMessage",
            { "1": sunsetTime }
          );
        }
      }
    } else if (isCitySelection || getCreatingReminderType(state, phoneNumber)) {
      // User selected a specific city (list row), or any unhandled id while a reminder flow expects a city.
      const flowContext: ReminderType | "settings" =
        state.lastCityPickerContext.get(phoneNumber) ??
        getCreatingReminderType(state, phoneNumber) ??
        "settings";
      const city = buttonIdentifier;
      await completeLocationSelection(state, phoneNumber, city, flowContext);
    } else {
      logger.info(
        `⚠️ Button "${buttonIdentifier}" is not recognized - no action taken`
      );
    }
  } catch (error) {
    logger.error(
      `❌ Error handling interactive button for ${phoneNumber}:`,
      error
    );
  }
}
