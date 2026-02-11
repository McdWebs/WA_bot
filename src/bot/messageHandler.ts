import registrationCommand from "./commands/registration";
import menuCommand from "./commands/menu";
// Database layer: use MongoDB instead of Supabase
import mongoService from "../services/mongo";
import hebcalService from "../services/hebcal";
import twilioService from "../services/twilio";
import logger from "../utils/logger";
import { Gender, ReminderType } from "../types";
import reminderService from "../services/reminderService";
import reminderStateManager, { ReminderStateMode } from "../services/reminderStateManager";
import timezoneService from "../utils/timezone";
import { config } from "../config";

const ISRAEL_TZ = "Asia/Jerusalem";

export class MessageHandler {
  /**
   * Checks if a message body represents a button click from an interactive template
   */
  isButtonClick(messageBody: string): boolean {
    if (!messageBody) return false;

    const normalized = messageBody.trim();

    // Check if it's a single digit (1-9) which is common for menu buttons
    // Also check for "1." or "1:" patterns that might come from templates
    if (/^[1-9][\.:]?$/.test(normalized) || /^[1-9]\s*[\.:]/.test(normalized)) {
      return true;
    }

    // Check for common button patterns
    const buttonPatterns = [
      /^sunset/i,
      /^candle/i,
      /^prayer/i,
      /^menu_/i,
      /^option\s*[1-9]/i,
    ];

    return buttonPatterns.some((pattern) => pattern.test(normalized));
  }

  async handleIncomingMessage(
    phoneNumber: string,
    messageBody: string
  ): Promise<string> {
    try {
      // Normalize message - trim and lowercase (Hebrew doesn't change with lowercase)
      const normalizedMessage = messageBody.trim().toLowerCase();
      const originalMessage = messageBody.trim();

      // Handle commands
      if (normalizedMessage.startsWith("/")) {
        return await this.handleCommand(phoneNumber, normalizedMessage);
      }

      // Check user state for reminder management flow
      const state = reminderStateManager.getState(phoneNumber);

      if (state?.mode === ReminderStateMode.CHOOSE_REMINDER) {
        // Check for cancel
        if (normalizedMessage.includes("ביטול") || normalizedMessage.includes("cancel")) {
          reminderStateManager.clearState(phoneNumber);
          await this.sendManageRemindersMenu(phoneNumber);
          return "";
        }

        // User is selecting a reminder by number (1, 2, 3...)
        const result = await reminderService.selectReminder(phoneNumber, messageBody);
        if (result) {
          await twilioService.sendMessage(phoneNumber, result);
        }
        return "";
      } else if (state?.mode === ReminderStateMode.REMINDER_ACTION) {
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
                await this.sendTimePickerForReminderType(
                  phoneNumber,
                  reminder.reminder_type,
                  user?.location
                );
              }
            }
          }
          // If action is "cancel", return to manage reminders menu
          if (action === "cancel") {
            await this.sendManageRemindersMenu(phoneNumber);
          }
          return "";
        } else {
          return "אנא בחר/י פעולה:\n✏️ *ערוך* - לעריכת התזכורת\n🗑️ *מחק* - למחיקת התזכורת\n❌ *ביטול* - לחזרה לתפריט הראשי";
        }
      } else if (state?.mode === ReminderStateMode.CONFIRMING_DELETE) {
        // User is confirming deletion
        return await this.handleDeleteConfirmation(phoneNumber, messageBody);
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

      // Check for "Show Reminders" text command (check both normalized and original)
      if (originalMessage.includes("הצג תזכורות") ||
        normalizedMessage.includes("הצג תזכורות") ||
        (originalMessage.includes("הצג") && originalMessage.includes("תזכורות")) ||
        (normalizedMessage.includes("הצג") && normalizedMessage.includes("תזכורות")) ||
        normalizedMessage === "show_reminders") {
        logger.debug(`📋 Text command matched: "הצג תזכורות" for ${phoneNumber}`);
        // Send loading message immediately for better UX
        await twilioService.sendMessage(phoneNumber, "⏳ טוען את התזכורות שלך...");
        const reminderService = (await import("../services/reminderService")).default;
        const result = await reminderService.listReminders(phoneNumber);
        if (result && result.trim() !== "") {
          await twilioService.sendMessage(phoneNumber, result);
        }
        return "";
      }

      // Check if this is a time picker selection that came as text (fallback for non-interactive buttons)
      // Sometimes Twilio sends time picker selections as text messages
      const creatingReminderType = this.getCreatingReminderType(phoneNumber);
      if (creatingReminderType) {
        // Allow direct minute values (10/20/30/45/60)
        if (/^(10|20|30|45|60)$/.test(normalizedMessage)) {
          logger.info(
            `⏰ Time picker selection detected as TEXT minutes: "${normalizedMessage}" for ${phoneNumber}, reminderType="${creatingReminderType}"`
          );
          // Send loading message for better UX
          await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
          await this.saveReminderFromTimePicker(
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
            await this.saveReminderFromTimePicker(
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
        this.creatingReminderType.set(phoneNumber, "tefillin");
        await this.sendCityPicker(phoneNumber, "tefillin");
        return "";
      } else if (originalMessage.includes("הדלקת נרות") ||
        originalMessage.includes("נרות") ||
        normalizedMessage.includes("הדלקת נרות") ||
        normalizedMessage.includes("נרות") ||
        normalizedMessage.includes("candle") ||
        normalizedMessage.includes("candle_lighting")) {
        logger.debug(`📋 Text command matched: "הדלקת נרות" for ${phoneNumber}`);
        this.creatingReminderType.set(phoneNumber, "candle_lighting");
        await this.sendCityPicker(phoneNumber, "candle_lighting");
        return "";
      } else if (originalMessage.includes("שמע") ||
        originalMessage.includes("קריאת שמע") ||
        normalizedMessage.includes("שמע") ||
        normalizedMessage.includes("קריאת שמע") ||
        normalizedMessage.includes("shema")) {
        logger.debug(`📋 Text command matched: "שמע" for ${phoneNumber}`);
        this.creatingReminderType.set(phoneNumber, "shema");
        await this.sendCityPicker(phoneNumber, "shema");
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
        await this.sendMainMenu(phoneNumber, gender);
        return "";
      } else if (originalMessage.includes("חזרה") ||
        normalizedMessage.includes("חזרה") ||
        normalizedMessage.includes("back")) {
        await this.sendManageRemindersMenu(phoneNumber);
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

  private async handleCommand(
    phoneNumber: string,
    command: string
  ): Promise<string> {
    const normalized = command.trim().toLowerCase();

    // Minimal command handling – gently push users to use buttons/templates
    if (normalized === "/start" || normalized === "/menu") {
      await twilioService.sendTemplateMessage(phoneNumber, "welcome");
      return "";
    }

    if (normalized === "/help") {
      return "אין צורך בפקודות טקסט 🙂 פשוט השתמש/י בכפתורים שבתפריטים כדי לנהל את התזכורות.";
    }

    return "המערכת עובדת עם כפתורים בלבד. שלח/י הודעה רגילה וקבל/י תפריט עם אפשרויות.";
  }

  /**
   * Sends main menu template based on user gender
   */
  async sendMainMenu(
    phoneNumber: string,
    gender: Gender
  ): Promise<void> {
    try {
      logger.info(
        `📋 Sending main menu to ${phoneNumber} for gender: ${gender}`
      );

      // Quick Reply templates don't support variables - buttons are static
      // The template should have all buttons defined, and we'll handle filtering on the backend
      // based on the button the user clicks
      const templateKey =
        gender === "female"
          ? "womanMenu"
          : "mainMenu";

      await twilioService.sendTemplateMessage(
        phoneNumber,
        templateKey
        // No variables - Quick Reply templates have static button text
      );

      logger.debug(`Main menu template sent to ${phoneNumber}`);
    } catch (error: any) {
      logger.error(`Error sending main menu to ${phoneNumber}:`, error);

      // Always send fallback menu for ANY error
      try {
        const user = await mongoService.getUserByPhone(phoneNumber);
        const userGender: Gender = (user?.gender as Gender) || gender;
        let menuText = "איזה תזכורת תרצה?\n\n";

        if (userGender === "male") {
          menuText += "1. הנחת תפילין\n2. זמן קריאת שמע";
        } else if (userGender === "female") {
          menuText += "1. הדלקת נרות שבת\n2. זמן קריאת שמע";
        } else {
          menuText += "1. הנחת תפילין\n2. הדלקת נרות שבת\n3. זמן קריאת שמע";
        }

        await twilioService.sendMessage(phoneNumber, menuText);
        logger.debug(`Fallback menu sent to ${phoneNumber}`);
      } catch (fallbackError) {
        logger.error(`❌ Failed to send fallback menu to ${phoneNumber}:`, fallbackError);
        throw fallbackError;
      }
    }
  }

  /**
   * Sends the "manage reminders" quick-reply menu
   */
  private async sendManageRemindersMenu(phoneNumber: string): Promise<void> {
    try {
      logger.debug(`Sending manage reminders menu to ${phoneNumber}`);
      await twilioService.sendTemplateMessage(phoneNumber, "manageReminders");
      logger.debug(`Manage reminders menu sent to ${phoneNumber}`);
    } catch (error) {
      logger.error(
        `Error sending manage reminders menu to ${phoneNumber}:`,
        error
      );
      await twilioService.sendMessage(
        phoneNumber,
        "לא הצלחתי לפתוח את תפריט ניהול התזכורות. נסה שוב מאוחר יותר."
      );
    }
  }

  async handleInteractiveButton(
    phoneNumber: string,
    buttonIdentifier: string
  ): Promise<void> {
    try {
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
      const creatingReminderType = this.getCreatingReminderType(phoneNumber);
      logger.info(
        `📋 Current creatingReminderType for ${phoneNumber}: "${creatingReminderType}"`
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
      const isMainMenuSelection =
        normalizedButton === "tefillin" ||
        normalizedButton === "candle_lighting" ||
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
        await this.sendMainMenu(phoneNumber, gender);
      } else if (isMainMenuSelection) {
        // User selected reminder type from main menu
        // For now, do NOT enforce gender-based restrictions – all users can choose any option
        if (normalizedButton === "tefillin") {
          // For tefillin, first ask for city, then time picker will be based on that city
          this.creatingReminderType.set(phoneNumber, "tefillin");
          await this.sendCityPicker(phoneNumber, "tefillin");
        } else if (normalizedButton === "candle_lighting") {
          // For candle lighting, also ask for city first
          this.creatingReminderType.set(phoneNumber, "candle_lighting");
          await this.sendCityPicker(phoneNumber, "candle_lighting");
        } else if (normalizedButton === "shema") {
          // For shema, also ask for city first
          this.creatingReminderType.set(phoneNumber, "shema");
          await this.sendCityPicker(phoneNumber, "shema");
        }
      } else if (isManageRemindersAction) {
        // Handle buttons from manage reminders quick-reply template
        if (normalizedButton === "manage_reminders") {
          // Main menu button to open the manage reminders menu
          await this.sendManageRemindersMenu(phoneNumber);
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
          const user = await mongoService.getUserByPhone(phoneNumber);
          const gender: Gender =
            (user?.gender as Gender) || "prefer_not_to_say";
          await this.sendMainMenu(phoneNumber, gender);
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
          await this.sendTimePickerForReminderType(
            phoneNumber,
            reminder.reminder_type,
            user.location
          );
        } else {
          // Fallback to sunset time picker
          await this.sendTimePickerForSunset(
            phoneNumber,
            user.location || "Jerusalem"
          );
        }
      } else if (isTimePickerSelection) {
        // User selected time from time picker
        const state = reminderStateManager.getState(phoneNumber);

        if (state?.mode === ReminderStateMode.EDIT_REMINDER && state.reminderId) {
          // Editing existing reminder - use ReminderService
          const reminder = await reminderService.getReminder(phoneNumber, state.reminderId);
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
              state.reminderId,
              offsetMinutes
            );
            await twilioService.sendMessage(phoneNumber, result);

            // Clear state
            reminderStateManager.clearState(phoneNumber);
            logger.info(
              `✅ Updated reminder ${state.reminderId} with offset ${offsetMinutes} for ${phoneNumber}`
            );
          }
        } else {
          // Creating new reminder - need to know which type
          const creatingReminderType = this.getCreatingReminderType(phoneNumber);
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
                const user = await mongoService.getUserByPhone(phoneNumber);
                const city = user?.location || null;

                // Send loading message for better UX
                await twilioService.sendMessage(phoneNumber, "⏳ שומר את התזכורת...");
                await this.saveCandleLightingReminder(phoneNumber, city, timeOption);
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
                await this.saveReminderFromTimePicker(
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
        // Women's flow: Hefsek Tahara – ask user to choose time (bot receives sunset)
        logger.info(
          `👩‍🧕 Tahara flow started (hefsek only) for ${phoneNumber}, button="${buttonIdentifier}"`
        );
        this.femaleFlowMode.set(phoneNumber, "taara");
        await this.sendTaaraTimePicker(phoneNumber);
      } else if (isClean7MenuSelection) {
        // Women's flow: Seven clean days – reminder by date (how many days passed); start_date = today
        logger.info(
          `👩‍🧕 7 clean days flow selected for ${phoneNumber}, button="${buttonIdentifier}"`
        );
        const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
        await this.saveClean7Reminder(phoneNumber, todayStr);
        await twilioService.sendTemplateMessage(phoneNumber, "clean7FinalMessage", {
          "1": "1",
        });
      } else if (isTaaraPlusClean7MenuSelection) {
        // Women's flow: Hefsek + 7 clean days – first ask for hefsek time (same picker, then CLEAN_7_START_TAARA_TIME with button to activate 7)
        logger.info(
          `👩‍🧕 Tahara + 7 clean days flow started for ${phoneNumber}, button="${buttonIdentifier}"`
        );
        this.femaleFlowMode.set(phoneNumber, "taara_plus_clean7");
        await this.sendTaaraTimePicker(phoneNumber);
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
        await this.saveClean7Reminder(phoneNumber, todayStr);
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
        await this.disableTaaraReminder(phoneNumber);
        await twilioService.sendMessage(
          phoneNumber,
          "התזכורת להפסק טהרה הופסקה."
        );
      } else if (isTaaraTimeSelection) {
        // User chose a concrete time (HH:MM) in the tahara time-picker template
        const timeOfDay = taaraTimeMatch![1];
        const mode = this.femaleFlowMode.get(phoneNumber) || "taara";

        // Allow cancel buttons as a safety net
        if (
          normalizedButton.includes("cancel") ||
          normalizedButton.includes("ביטול")
        ) {
          logger.info(
            `👩‍🧕 Tahara flow cancelled by user ${phoneNumber}, button="${buttonIdentifier}"`
          );
          this.femaleFlowMode.delete(phoneNumber);
          await twilioService.sendMessage(
            phoneNumber,
            "התזכורת להפסק טהרה בוטלה."
          );
        } else {
          logger.info(
            `👩‍🧕 Tahara time selected for ${phoneNumber}: ${timeOfDay}, mode=${mode}`
          );
          const user = await mongoService.getUserByPhone(phoneNumber);
          const location = user?.location || this.inferLocationFromPhoneNumber(phoneNumber);
          const todayStr = timezoneService.getDateInTimezone(ISRAEL_TZ);
          const sunsetTime = await hebcalService.getSunsetTime(location, todayStr) || "18:00";

          // Always save hefsek tahara reminder
          await this.saveTaaraReminder(phoneNumber, timeOfDay);
          this.femaleFlowMode.delete(phoneNumber);

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
      } else if (isCitySelection || this.getCreatingReminderType(phoneNumber)) {
        // User selected a specific city.
        // If isCitySelection=false but we have creatingReminderType,
        // treat ANY unhandled button here as a city identifier from the template.
        const currentReminderType = this.getCreatingReminderType(phoneNumber);
        const city = buttonIdentifier;

        await mongoService.updateUser(phoneNumber, { location: city });
        logger.info(
          `✅ Saved location "${city}" for reminder flow (${currentReminderType || "unknown"}) for ${phoneNumber}`
        );

        if (currentReminderType === "candle_lighting") {
          // Candle lighting flow: save city, then show time picker
          await this.sendCandleLightingTimePicker(phoneNumber);
        } else if (currentReminderType === "tefillin") {
          // Tefillin flow: save location, then show tefillin time picker
          await this.sendTefilinTimePicker(phoneNumber, city);
        } else if (currentReminderType === "shema") {
          // Shema flow: save location, then show shema time picker
          await this.sendShemaTimePicker(phoneNumber);
        } else {
          logger.info(
            `⚠️ City "${city}" selected but no active reminder type for ${phoneNumber} - location updated only`
          );
        }
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

  /**
   * Infers location from phone number country code
   */
  private inferLocationFromPhoneNumber(phoneNumber: string): string {
    // Remove any non-digit characters except +
    const cleaned = phoneNumber.replace(/[^\d+]/g, "");

    // Country code to location mapping (for Hebrew calendar, prioritize Israel)
    const countryCodeMap: Record<string, string> = {
      "972": "Jerusalem", // Israel
      "1": "New York", // USA/Canada
      "44": "London", // UK
      "33": "Paris", // France
      "49": "Berlin", // Germany
      "7": "Moscow", // Russia
      "61": "Sydney", // Australia
      "81": "Tokyo", // Japan
    };

    // Extract country code (first 1-3 digits after +)
    for (const [code, city] of Object.entries(countryCodeMap)) {
      if (cleaned.startsWith(`+${code}`) || cleaned.startsWith(code)) {
        logger.info(
          `Inferred location "${city}" from phone number country code: ${code}`
        );
        return city;
      }
    }

    // Default to Jerusalem for Hebrew calendar
    logger.info(
      `Using default location "Jerusalem" for phone number: ${phoneNumber}`
    );
    return "Jerusalem";
  }

  private async sendTimePickerForSunset(
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
        validLocation = this.inferLocationFromPhoneNumber(phoneNumber);
      }

      // Try to get sunset data with the location
      let sunsetData = await hebcalService.getSunsetData(validLocation);

      // If that fails, try with inferred location from phone number (if different)
      if (!sunsetData) {
        const inferredLocation = this.inferLocationFromPhoneNumber(phoneNumber);
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

  // Track which reminder type is being created
  private creatingReminderType = new Map<string, ReminderType>();

   // Track current women's-flow mode per user (hefsek only vs hefsek+7)
  private femaleFlowMode = new Map<string, "taara" | "taara_plus_clean7">();

  /**
   * Sends time picker for tefillin reminder
   * If locationOverride is provided (from city picker), use it; otherwise use user.location / inferred city.
   */
  private async sendTefilinTimePicker(
    phoneNumber: string,
    locationOverride?: string
  ): Promise<void> {
    try {
      logger.debug(`Sending tefillin time picker to ${phoneNumber}`);
      this.creatingReminderType.set(phoneNumber, "tefillin");

      // Determine base location: prefer explicit override, then saved user.location, then inferred city
      const user = await mongoService.getUserByPhone(phoneNumber);
      const baseLocation =
        locationOverride ||
        (user && user.location) ||
        this.inferLocationFromPhoneNumber(phoneNumber);

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
  private async sendCityPicker(
    phoneNumber: string,
    reminderType?: ReminderType
  ): Promise<void> {
    try {
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
        "איזה עיר אתה?\n\n1. ירושלים\n2. באר שבע\n3. תל אביב\n4. אילת\n5. חיפה"
      );
    }
  }

  /**
   * Women's flow: send tahara time-picker template; bot receives sunset time (for display in template).
   */
  private async sendTaaraTimePicker(phoneNumber: string): Promise<void> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      const location = user?.location || this.inferLocationFromPhoneNumber(phoneNumber);
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
  private async sendCandleLightingTimePicker(phoneNumber: string): Promise<void> {
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

      // Send template with candle lighting time as variable {{1}}
      await twilioService.sendTemplateMessage(phoneNumber, "candleLightingTimePicker", {
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
  private async sendShemaTimePicker(phoneNumber: string): Promise<void> {
    try {
      logger.debug(`Sending shema time picker to ${phoneNumber}`);
      this.creatingReminderType.set(phoneNumber, "shema");

      // Determine base location: use user's saved location if available, otherwise infer from phone
      const user = await mongoService.getUserByPhone(phoneNumber);
      const baseLocation =
        (user && user.location) ||
        this.inferLocationFromPhoneNumber(phoneNumber);

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

  /**
   * Saves reminder from time picker selection
   */
  private async saveReminderFromTimePicker(
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

      this.creatingReminderType.delete(phoneNumber);

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
   * Converts English city name to Hebrew
   */
  private getCityNameInHebrew(city: string | null): string {
    if (!city) return "לא צוין";

    const cityMap: Record<string, string> = {
      "Jerusalem": "ירושלים",
      "Beer Sheva": "באר שבע",
      "Tel Aviv": "תל אביב",
      "Eilat": "אילת",
      "Haifa": "חיפה",
    };

    // Check exact match first
    if (cityMap[city]) {
      return cityMap[city];
    }

    // Check case-insensitive match
    const normalizedCity = city.trim();
    for (const [en, he] of Object.entries(cityMap)) {
      if (en.toLowerCase() === normalizedCity.toLowerCase()) {
        return he;
      }
    }

    // If already in Hebrew or unknown, return as is
    return city;
  }

  /**
   * Saves candle lighting reminder with location and time option
   */
  private async saveCandleLightingReminder(
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

      this.creatingReminderType.delete(phoneNumber);

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
        if (config.templates.candleLightingFinalMessage?.trim()) {
          await twilioService.sendTemplateMessage(
            phoneNumber,
            "candleLightingFinalMessage",
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
          const cityName = this.getCityNameInHebrew(city);
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
        const cityName = this.getCityNameInHebrew(city);
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
  private async saveTaaraReminder(
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
      const offsetMinutes = this.parseTimeOfDayToMinutes(timeOfDay);

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
  private async disableTaaraReminder(phoneNumber: string): Promise<void> {
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
   * Sends daily at 09:00; template receives day number (1–7) and today's date (by clean_7_start_date).
   * @param startDate YYYY-MM-DD in Israel timezone (default: today)
   */
  private async saveClean7Reminder(
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
      const offsetMinutes = this.parseTimeOfDayToMinutes(timeOfDay);

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
   * Parses "HH:MM" into minutes from midnight.
   * Falls back to 0 if parsing fails.
   */
  private parseTimeOfDayToMinutes(timeOfDay: string | null): number {
    if (!timeOfDay) return 0;
    const match = timeOfDay.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
    return hours * 60 + minutes;
  }

  /**
   * Gets the reminder type currently being created
   */
  private getCreatingReminderType(phoneNumber: string): ReminderType | null {
    return this.creatingReminderType.get(phoneNumber) || null;
  }

  /**
   * Updates existing reminder from time picker
   */
  private async updateReminderFromTimePicker(
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

  private getReminderTypeNameHebrew(type: string): string {
    const types: Record<string, string> = {
      tefillin: "הנחת תפילין",
      candle_lighting: "הדלקת נרות",
      shema: "זמן קריאת שמע",
      sunset: "זמני שקיעה",
      prayer: "זמני תפילה",
    };
    return types[type] || type;
  }

  /**
   * Handles delete confirmation
   */
  private async handleDeleteConfirmation(
    phoneNumber: string,
    messageBody: string
  ): Promise<string> {
    try {
      const normalized = messageBody.trim().toLowerCase();
      const state = reminderStateManager.getState(phoneNumber);

      if (!state || state.mode !== ReminderStateMode.CONFIRMING_DELETE || !state.reminderId) {
        reminderStateManager.clearState(phoneNumber);
        return "❌ לא נמצאה תזכורת למחיקה.";
      }

      if (normalized === "כן" || normalized === "yes" || normalized === "אישור") {
        // Send loading message for better UX
        await twilioService.sendMessage(phoneNumber, "⏳ מוחק את התזכורת...");
        // Delete the reminder using ReminderService
        const result = await reminderService.deleteReminder(phoneNumber, state.reminderId);

        // Clear state
        reminderStateManager.clearState(phoneNumber);

        await twilioService.sendMessage(phoneNumber, result);
        return "";
      } else if (normalized === "לא" || normalized === "no" || normalized === "ביטול") {
        // Cancel deletion
        reminderStateManager.clearState(phoneNumber);
        await twilioService.sendMessage(phoneNumber, "❌ המחיקה בוטלה.");
        return "";
      } else {
        return "אנא שלח/י 'כן' לאישור או 'לא' לביטול.";
      }
    } catch (error) {
      logger.error("Error handling delete confirmation:", error);
      reminderStateManager.clearState(phoneNumber);
      return "סליחה, אירעה שגיאה. נסה שוב.";
    }
  }

  /**
   * Sends appropriate time picker based on reminder type
   */
  private async sendTimePickerForReminderType(
    phoneNumber: string,
    reminderType: ReminderType,
    location?: string
  ): Promise<void> {
    if (reminderType === "tefillin") {
      await this.sendTefilinTimePicker(phoneNumber, location);
    } else if (reminderType === "shema") {
      await this.sendShemaTimePicker(phoneNumber);
    } else if (reminderType === "candle_lighting") {
      // Candle lighting doesn't use time picker, but if editing, we might need to handle it
      await twilioService.sendMessage(
        phoneNumber,
        "תזכורת הדלקת נרות נשלחת כל יום שישי ב-8:00 בבוקר. אין צורך לבחור זמן."
      );
    } else {
      // Fallback: use sunset time picker
      await this.sendTimePickerForSunset(phoneNumber, location || "Jerusalem");
    }
  }
}

export default new MessageHandler();
