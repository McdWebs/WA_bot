import mongoService from "../../services/mongo";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import type { Gender } from "../../types";
import reminderService from "../../services/reminderService";
import reminderStateManager, { ReminderStateMode } from "../../services/reminderStateManager";
import settingsStateManager, { SettingsStateMode } from "../../services/settingsStateManager";
import { handleCommand } from "./commands";
import { handleDeleteConfirmation } from "./deleteConfirmation";
import { continueReminderFlowWithSavedLocation } from "./locationFlow";
import { sendMainMenu, sendManageRemindersMenu } from "./menus";
import { saveReminderFromTimePicker } from "./persistence";
import { sendCityPicker, sendTimePickerForReminderType } from "./pickers";
import { getCreatingReminderType } from "./stateAccess";
import type { MessageHandlerMutableState } from "./state";

export async function incomingMessageFlow(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  messageBody: string
): Promise<string> {
  try {
    // Normalize message - trim and lowercase (Hebrew doesn't change with lowercase)
    const normalizedMessage = messageBody.trim().toLowerCase();
    const originalMessage = messageBody.trim();

    // Handle commands
    if (normalizedMessage.startsWith("/")) {
      return await handleCommand(phoneNumber, normalizedMessage);
    }

    // Check user state for settings flow (free-form settings menu)
    const settingsState = settingsStateManager.getState(phoneNumber);

    if (settingsState?.mode === SettingsStateMode.MAIN_MENU) {
      // User is choosing from settings main menu: 1=gender, 2=reminders, 3=location
      if (/^1\b/.test(normalizedMessage)) {
        // Change gender
        settingsStateManager.setState(phoneNumber, {
          mode: SettingsStateMode.CHANGE_GENDER,
        });
        await twilioService.sendMessage(
          phoneNumber,
          "⚙️ שינוי מגדר\n\n*בחר/י מגדר:*\n1️⃣ גבר\n2️⃣ אישה\n\nאו שלח/י *ביטול* לחזרה למסך הראשי."
        );
        return "";
      } else if (/^2\b/.test(normalizedMessage)) {
        // Edit/delete reminders – reuse existing reminder list & flow
        settingsStateManager.clearState(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "⏳ טוען את התזכורות שלך..."
        );
        const result = await reminderService.listReminders(phoneNumber);
        if (result && result.trim() !== "") {
          await twilioService.sendMessage(phoneNumber, result);
        }
        return "";
      } else if (/^3\b/.test(normalizedMessage)) {
        // Change location – reuse existing city picker template
        settingsStateManager.clearState(phoneNumber);
        await sendCityPicker(state, phoneNumber);
        return "";
      } else if (
        normalizedMessage.includes("ביטול") ||
        normalizedMessage.includes("cancel")
      ) {
        settingsStateManager.clearState(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "תפריט ההגדרות נסגר."
        );
        return "";
      } else {
        await twilioService.sendMessage(
          phoneNumber,
          "אנא בחר/י מספר מהתפריט:\n1️⃣ שינוי מגדר\n2️⃣ עריכת / מחיקת תזכורות\n3️⃣ שינוי מיקום\nאו שלח/י *ביטול* לסגירת התפריט."
        );
        return "";
      }
    } else if (settingsState?.mode === SettingsStateMode.CHANGE_GENDER) {
      // User is choosing gender: 1=male, 2=female
      if (/^1\b/.test(normalizedMessage)) {
        await mongoService.updateUser(phoneNumber, { gender: "male" });
        settingsStateManager.clearState(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "✅ המגדר עודכן ל*גבר*."
        );
        return "";
      } else if (/^2\b/.test(normalizedMessage)) {
        await mongoService.updateUser(phoneNumber, { gender: "female" });
        settingsStateManager.clearState(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "✅ המגדר עודכן ל*אישה*."
        );
        return "";
      } else if (
        normalizedMessage.includes("ביטול") ||
        normalizedMessage.includes("cancel")
      ) {
        settingsStateManager.clearState(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "שינוי המגדר בוטל."
        );
        return "";
      } else {
        await twilioService.sendMessage(
          phoneNumber,
          "אנא בחר/י:\n1️⃣ גבר\n2️⃣ אישה\nאו שלח/י *ביטול* לביטול השינוי ולחזרה למסך הראשי."
        );
        return "";
      }
    }

    // Check user state for reminder management flow
    const reminderFlowState = reminderStateManager.getState(phoneNumber);

    if (reminderFlowState?.mode === ReminderStateMode.CHOOSE_REMINDER) {
      // Check for cancel
      if (normalizedMessage.includes("ביטול") || normalizedMessage.includes("cancel")) {
        reminderStateManager.clearState(phoneNumber);
        await sendManageRemindersMenu(phoneNumber);
        return "";
      }

      // User is selecting a reminder by number (1, 2, 3...)
      const result = await reminderService.selectReminder(phoneNumber, messageBody);
      if (result) {
        await twilioService.sendMessage(phoneNumber, result);
      }
      return "";
    } else if (reminderFlowState?.mode === ReminderStateMode.REMINDER_ACTION) {
      // User selected a reminder and now choosing action (edit/delete/back/cancel)
      const normalized = normalizedMessage;
      let action: "edit" | "delete" | "back" | "cancel" | null = null;

      if (normalized.includes("ערוך") || normalized.includes("edit")) {
        action = "edit";
      } else if (normalized.includes("מחק") || normalized.includes("delete")) {
        action = "delete";
      } else if (normalized.includes("ביטול") || normalized.includes("cancel")) {
        action = "cancel";
      }

      if (action) {
        const result = await reminderService.handleReminderAction(phoneNumber, action);
        if (result) {
          await twilioService.sendMessage(phoneNumber, result);
        }
        // If action is "edit", the service returns empty string and handler will send time picker
        if (action === "edit") {
          const reminderId = reminderStateManager.getReminderId(phoneNumber);
          if (reminderId) {
            const reminder = await reminderService.getReminder(phoneNumber, reminderId);
            if (reminder) {
              const user = await mongoService.getUserByPhone(phoneNumber);
              await sendTimePickerForReminderType(
                state,
                phoneNumber,
                reminder.reminder_type,
                user?.location
              );
            }
          }
        }
        // If action is "cancel", return to manage reminders menu
        if (action === "cancel") {
          await sendManageRemindersMenu(phoneNumber);
        }
        return "";
      } else {
        return "אנא בחר/י פעולה:\n✏️ *ערוך* - לעריכת התזכורת\n🗑️ *מחק* - למחיקת התזכורת\n❌ *ביטול* - לחזרה לתפריט הראשי";
      }
    } else if (reminderFlowState?.mode === ReminderStateMode.CONFIRMING_DELETE) {
      // User is confirming deletion
      return await handleDeleteConfirmation(phoneNumber, messageBody);
    }

    // Check if this is a new user
    // Note: Welcome template should have been sent in index.ts for new users
    // If we reach here, it means user sent a message after welcome template
    const user = await mongoService.getUserByPhone(phoneNumber);

    if (!user) {
      // User doesn't exist - welcome template should have been sent in index.ts
      // If they're sending a message, it might be clicking the welcome button
      // The button click will be handled by handleInteractiveButton
      return "";
    }

    // User chose "custom location" — expect WhatsApp shared location pin (see handleIncomingLocation)
    if (state.awaitingCustomLocation.has(phoneNumber)) {
      if (
        normalizedMessage.includes("ביטול") ||
        normalizedMessage.includes("cancel")
      ) {
        state.awaitingCustomLocation.delete(phoneNumber);
        state.lastCityPickerContext.delete(phoneNumber);
        state.creatingReminderType.delete(phoneNumber);
        state.femaleFlowMode.delete(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "בחירת המיקום בוטלה. אפשר לחזור לתפריט ולנסות שוב."
        );
        return "";
      }
      await twilioService.sendMessage(
        phoneNumber,
        "📍 נא לשלוח *מיקום* דרך ווטסאפ (📎 ← *מיקום*) ולא הודעת טקסט."
      );
      return "";
    }

    // Fallback text menu: option 6 = custom location via WhatsApp pin (only while city picker context is active)
    if (
      normalizedMessage === "6" &&
      state.lastCityPickerContext.has(phoneNumber)
    ) {
      state.awaitingCustomLocation.add(phoneNumber);
      await twilioService.sendMessage(
        phoneNumber,
        "📍 שלחו עכשיו *מיקום* מווטסאפ (📎 ← מיקום)."
      );
      return "";
    }

    // Check for "Show Reminders" text command (check both normalized and original)
    if (originalMessage.includes("הצג תזכורות") ||
      normalizedMessage.includes("הצג תזכורות") ||
      (originalMessage.includes("הצג") && originalMessage.includes("תזכורות")) ||
      (normalizedMessage.includes("הצג") && normalizedMessage.includes("תזכורות")) ||
      normalizedMessage === "show_reminders") {
      logger.debug(`📋 Text command matched: "הצג תזכורות" for ${phoneNumber}`);
      // Send loading message immediately for better UX
      await twilioService.sendMessage(phoneNumber, "⏳ טוען את התזכורות שלך...");
      const reminderServiceDyn = (await import("../../services/reminderService")).default;
      const result = await reminderServiceDyn.listReminders(phoneNumber);
      if (result && result.trim() !== "") {
        await twilioService.sendMessage(phoneNumber, result);
      }
      return "";
    }

    // Check if this is a time picker selection that came as text (fallback for non-interactive buttons)
    // Sometimes Twilio sends time picker selections as text messages
    const creatingReminderType = getCreatingReminderType(state, phoneNumber);
    if (creatingReminderType) {
      // Allow direct minute values (10/20/30/45/60)
      if (/^(10|20|30|45|60)$/.test(normalizedMessage)) {
        logger.info(
          `⏰ Time picker selection detected as TEXT minutes: "${normalizedMessage}" for ${phoneNumber}, reminderType="${creatingReminderType}"`
        );
        // Send loading message for better UX
        await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
        await saveReminderFromTimePicker(
          state,
          phoneNumber,
          creatingReminderType,
          normalizedMessage
        );
        return "";
      }

      // Also allow numeric options 1/2/3 from text menus
      if (/^[1-3]$/.test(normalizedMessage)) {
        const optionToMinutes: Record<string, string> = {
          "1": "10",
          "2": "30",
          "3": "60",
        };
        const mapped = optionToMinutes[normalizedMessage];
        if (mapped) {
          logger.info(
            `⏰ Time picker numeric option detected as TEXT: "${normalizedMessage}" -> "${mapped}" for ${phoneNumber}, reminderType="${creatingReminderType}"`
          );
          await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
          await saveReminderFromTimePicker(
            state,
            phoneNumber,
            creatingReminderType,
            mapped
          );
          return "";
        }
      }
    }

    // Check for text-based reminder type selection (check both normalized and original)
    if (originalMessage.includes("תפילין") ||
      normalizedMessage.includes("תפילין") ||
      normalizedMessage.includes("tefillin")) {
      logger.debug(`📋 Text command matched: "תפילין" for ${phoneNumber}`);
      const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
        state,
        phoneNumber,
        "tefillin"
      );
      if (!continuedWithSavedLocation) {
        state.creatingReminderType.set(phoneNumber, "tefillin");
        await sendCityPicker(state, phoneNumber, "tefillin");
      }
      return "";
    } else if (originalMessage.includes("הדלקת נרות") ||
      originalMessage.includes("נרות") ||
      normalizedMessage.includes("הדלקת נרות") ||
      normalizedMessage.includes("נרות") ||
      normalizedMessage.includes("candle") ||
      normalizedMessage.includes("candle_lighting")) {
      logger.debug(`📋 Text command matched: "הדלקת נרות" for ${phoneNumber}`);
      const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
        state,
        phoneNumber,
        "candle_lighting"
      );
      if (!continuedWithSavedLocation) {
        state.creatingReminderType.set(phoneNumber, "candle_lighting");
        await sendCityPicker(state, phoneNumber, "candle_lighting");
      }
      return "";
    } else if (originalMessage.includes("שמע") ||
      originalMessage.includes("קריאת שמע") ||
      normalizedMessage.includes("שמע") ||
      normalizedMessage.includes("קריאת שמע") ||
      normalizedMessage.includes("shema")) {
      logger.debug(`📋 Text command matched: "שמע" for ${phoneNumber}`);
      const continuedWithSavedLocation = await continueReminderFlowWithSavedLocation(
        state,
        phoneNumber,
        "shema"
      );
      if (!continuedWithSavedLocation) {
        state.creatingReminderType.set(phoneNumber, "shema");
        await sendCityPicker(state, phoneNumber, "shema");
      }
      return "";
    }

    // Check for text-based actions
    if (originalMessage.includes("תזכורת חדשה") ||
      originalMessage.includes("חדשה") ||
      originalMessage.includes("הוסף תזכורת") ||
      normalizedMessage.includes("תזכורת חדשה") ||
      normalizedMessage.includes("חדשה") ||
      normalizedMessage.includes("הוסף תזכורת") ||
      normalizedMessage === "add_reminder") {
      const gender: Gender = (user.gender as Gender) || "prefer_not_to_say";
      await sendMainMenu(phoneNumber, gender);
      return "";
    } else if (
      originalMessage.includes("הגדרות") ||
      normalizedMessage.includes("הגדרות") ||
      normalizedMessage === "settings"
    ) {
      // Free-form settings menu (Hebrew)
      settingsStateManager.setState(phoneNumber, {
        mode: SettingsStateMode.MAIN_MENU,
      });
      await twilioService.sendMessage(
        phoneNumber,
        "⚙️ *הגדרות משתמש*\n\nבחר/י מספר פעולה:\n1️⃣ שינוי מגדר\n2️⃣ עריכת / מחיקת תזכורות\n3️⃣ שינוי מיקום\n\nאו שלח/י *ביטול* לחזרה למסך הראשי."
      );
      return "";
    } else if (originalMessage.includes("חזרה") ||
      normalizedMessage.includes("חזרה") ||
      normalizedMessage.includes("back")) {
      await sendManageRemindersMenu(phoneNumber);
      return "";
    }

    // Default: no action needed - welcome template already sent in index.ts for text messages
    // If we reach here, it means the message was a specific command that didn't match
    logger.debug(`📋 No text command matched for "${originalMessage}" (normalized: "${normalizedMessage}"), no action taken`);
    return ""; // No response needed
  } catch (error) {
    logger.error("Error handling incoming message:", error);
    return "סליחה, אירעה שגיאה בעיבוד ההודעה. נסה שוב.";
  }
}
