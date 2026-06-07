import mongoService from "./mongo";
import reminderStateManager, { ReminderStateMode } from "./reminderStateManager";
import logger from "../utils/logger";
import { ReminderType, ReminderSetting } from "../types";

/**
 * Business logic layer for reminder management
 * 
 * Flow:
 * 1. listReminders() -> Sets CHOOSE_REMINDER state, returns text list
 * 2. selectReminder() -> User sends number (1,2,3), sets REMINDER_ACTION state
 * 3. handleReminderAction("edit") -> Sets EDIT_REMINDER state, returns empty (handler sends time picker)
 * 4. User selects time -> updateReminderOffset() updates DB, clears state
 * 
 * OR:
 * 3. handleReminderAction("delete") -> Sets CONFIRMING_DELETE state
 * 4. User confirms -> deleteReminder() deletes from DB, clears state
 */
export class ReminderService {
  /**
   * Lists all active reminders for a user and sets CHOOSE_REMINDER state
   * Returns formatted text message (NO TEMPLATES)
   */
  async listReminders(phoneNumber: string): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "אנא השלם/י רישום קודם. שלח/י כל הודעה כדי להתחיל.";
      }

      // Fetch all active reminders
      const settings = await mongoService.getReminderSettings(user.id);
      const activeReminders = settings.filter((s) => s.enabled);

      if (activeReminders.length === 0) {
        return "📭 אין לך תזכורות עדיין.\n\nהשתמש/י בתפריט כדי להוסיף תזכורת חדשה.";
      }

      // Build text message with numbered list
      let message = "📋 התזכורות שלך:\n\n";

      // Create reminder mapping: index -> reminderId
      const reminders: Array<{ index: number; reminderId: string }> = [];

      activeReminders.forEach((setting, idx) => {
        const index = idx + 1;
        const typeNameHeb = this.formatReminderTypeHebrew(setting.reminder_type);
        const minutes = setting.time_offset_minutes;

        // Format time offset
        let timeText: string;
        if (minutes === 0) {
          timeText = "בזמן";
        } else if (minutes < 0) {
          timeText = `${Math.abs(minutes)} דקות לפני סוף זמן`;
        } else {
          timeText = `${minutes} דקות אחרי סוף זמן`;
        }

        message += `${index}️⃣ ${typeNameHeb} – ${timeText}\n`;

        // Store mapping
        reminders.push({
          index,
          reminderId: setting.id!,
        });
      });

      // Set state: user is now in CHOOSE_REMINDER mode
      reminderStateManager.setState(phoneNumber, {
        mode: ReminderStateMode.CHOOSE_REMINDER,
        reminders,
      });

      message += `\nשלח/י מספר תזכורת (1-${activeReminders.length}) לעריכה או מחיקה.\n❌ *ביטול* - לחזרה לתפריט הראשי`;

      return message;
    } catch (error) {
      logger.error("Error listing reminders:", error);
      return "סליחה, אירעה שגיאה בטעינת התזכורות. נסה שוב מאוחר יותר.";
    }
  }

  /**
   * Handles user's number selection (1, 2, 3...)
   * Transitions to REMINDER_ACTION mode
   */
  async selectReminder(phoneNumber: string, numberInput: string): Promise<string> {
    try {
      // Validate state
      if (!reminderStateManager.isInMode(phoneNumber, ReminderStateMode.CHOOSE_REMINDER)) {
        return "אנא בחר/י תזכורת מהרשימה תחילה.";
      }

      // Check for cancel first
      const normalizedInput = numberInput.toLowerCase().trim();
      if (normalizedInput.includes("ביטול") || normalizedInput.includes("cancel")) {
        reminderStateManager.clearState(phoneNumber);
        // Return empty string - handler will send manage reminders menu template
        return "";
      }

      // Extract number from input
      const numberMatch = numberInput.match(/^(\d+)/);
      if (!numberMatch) {
        return "אנא שלח/י מספר תזכורת (1, 2, 3 וכו') או ❌ *ביטול* לחזרה לתפריט.";
      }

      const selectedIndex = parseInt(numberMatch[1], 10);
      const reminderId = reminderStateManager.getReminderIdByIndex(
        phoneNumber,
        selectedIndex
      );

      if (!reminderId) {
        return "❌ מספר תזכורת לא תקין. אנא בחר/י מספר מהרשימה.";
      }

      // Get reminder details
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "שגיאה: משתמש לא נמצא.";
      }

      const allSettings = await mongoService.getReminderSettings(user.id);
      const reminder = allSettings.find((s) => s.id === reminderId && s.enabled);

      if (!reminder) {
        return "❌ תזכורת לא נמצאה.";
      }

      // Transition to REMINDER_ACTION mode
      reminderStateManager.setState(phoneNumber, {
        mode: ReminderStateMode.REMINDER_ACTION,
        reminderId,
      });

      // Format reminder details
      const typeNameHeb = this.formatReminderTypeHebrew(reminder.reminder_type);
      const minutes = reminder.time_offset_minutes;
      let timeText: string;
      if (minutes === 0) {
        timeText = "בזמן";
      } else if (minutes < 0) {
        timeText = `${Math.abs(minutes)} דקות לפני סוף זמן`;
      } else {
        timeText = `${minutes} דקות אחרי סוף זמן`;
      }

      return `📌 תזכורת נבחרה:\n\n${typeNameHeb} – ${timeText}\n\nמה תרצה לעשות?\n\nשלח/י:\n✏️ *ערוך* - לעריכת התזכורת\n🗑️ *מחק* - למחיקת התזכורת\n❌ *ביטול* - לחזרה לתפריט הראשי`;
    } catch (error) {
      logger.error("Error selecting reminder:", error);
      return "סליחה, אירעה שגיאה. נסה שוב.";
    }
  }

  /**
   * Handles action selection (edit/delete)
   * Returns message or empty string if action was handled (e.g., template sent)
   */
  async handleReminderAction(
    phoneNumber: string,
    action: "edit" | "delete" | "cancel"
  ): Promise<string> {
    try {
      // Validate state
      if (!reminderStateManager.isInMode(phoneNumber, ReminderStateMode.REMINDER_ACTION)) {
        return "אנא בחר/י תזכורת תחילה.";
      }

      const reminderId = reminderStateManager.getReminderId(phoneNumber);
      if (!reminderId) {
        reminderStateManager.clearState(phoneNumber);
        return "❌ לא נמצאה תזכורת. אנא בחר/י תזכורת מהרשימה.";
      }

      if (action === "cancel") {
        // Cancel and return to manage reminders menu
        reminderStateManager.clearState(phoneNumber);
        // Return empty string - handler will send manage reminders menu template
        return "";
      } else if (action === "delete") {
        // Transition to CONFIRMING_DELETE mode
        const user = await mongoService.getUserByPhone(phoneNumber);
        if (!user || !user.id) {
          return "שגיאה: משתמש לא נמצא.";
        }

        const allSettings = await mongoService.getReminderSettings(user.id);
        const reminder = allSettings.find((s) => s.id === reminderId);

        if (!reminder) {
          reminderStateManager.clearState(phoneNumber);
          return "❌ תזכורת לא נמצאה.";
        }

        reminderStateManager.setState(phoneNumber, {
          mode: ReminderStateMode.CONFIRMING_DELETE,
          reminderId,
        });

        const typeNameHeb = this.formatReminderTypeHebrew(reminder.reminder_type);
        return `⚠️ האם אתה בטוח שברצונך למחוק את התזכורת:\n\n${typeNameHeb}\n\nשלח/י *כן* לאישור או *לא* לביטול.`;
      } else if (action === "edit") {
        // Transition to EDIT_REMINDER mode
        // The time picker template will be sent by the handler
        reminderStateManager.setState(phoneNumber, {
          mode: ReminderStateMode.EDIT_REMINDER,
          reminderId,
        });
        // Return empty string - handler will send template
        return "";
      }

      return "";
    } catch (error) {
      logger.error("Error handling reminder action:", error);
      reminderStateManager.clearState(phoneNumber);
      return "סליחה, אירעה שגיאה. נסה שוב.";
    }
  }

  /**
   * Deletes a reminder (sets enabled = false)
   */
  async deleteReminder(phoneNumber: string, reminderId: string): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "אנא השלם/י רישום קודם.";
      }

      // Verify reminder belongs to user
      const allSettings = await mongoService.getReminderSettings(user.id);
      const reminderToDelete = allSettings.find((s) => s.id === reminderId);

      if (!reminderToDelete) {
        logger.warn(`Reminder ${reminderId} not found for user ${phoneNumber}`);
        return "❌ תזכורת לא נמצאה.";
      }

      if (reminderToDelete.user_id !== user.id) {
        return "❌ ניתן למחוק רק את התזכורות שלך.";
      }

      logger.debug(`Deleting reminder ${reminderId} for user ${phoneNumber}`);
      
      // Delete from database
      await mongoService.deleteReminderSetting(reminderId);
      
      // Verify deletion
      const settingsAfterDelete = await mongoService.getReminderSettings(user.id);
      const stillExists = settingsAfterDelete.find((s) => s.id === reminderId);
      if (stillExists) {
        logger.error(`Reminder ${reminderId} still exists after delete attempt!`);
        return "❌ שגיאה: התזכורת לא נמחקה. נסה שוב.";
      }

      logger.debug(`Deleted reminder ${reminderId} for user ${phoneNumber}`);
      const typeNameHeb = this.formatReminderTypeHebrew(reminderToDelete.reminder_type);
      return `✅ התזכורת "${typeNameHeb}" נמחקה בהצלחה.`;
    } catch (error) {
      logger.error("Error deleting reminder:", error);
      return "סליחה, אירעה שגיאה במחיקת התזכורת. נסה שוב.";
    }
  }

  /**
   * Updates an EXISTING reminder's offsetMinutes
   * Does NOT create a new reminder
   */
  async updateReminderOffset(
    phoneNumber: string,
    reminderId: string,
    offsetMinutes: number
  ): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "אנא השלם/י רישום קודם.";
      }

      // Find the existing reminder
      const allSettings = await mongoService.getReminderSettings(user.id);
      const existingReminder = allSettings.find((s) => s.id === reminderId);

      if (!existingReminder) {
        return "❌ תזכורת לא נמצאה.";
      }

      if (existingReminder.user_id !== user.id) {
        return "❌ ניתן לערוך רק את התזכורות שלך.";
      }

      // Update ONLY the offsetMinutes by ID (more reliable than upsert)
      if (!existingReminder.id) {
        throw new Error("Reminder ID is missing");
      }
      
      await mongoService.updateReminderSettingById(existingReminder.id, {
        enabled: existingReminder.enabled,
        time_offset_minutes: offsetMinutes, // Updated value
      });

      const typeNameHeb = this.formatReminderTypeHebrew(existingReminder.reminder_type);
      const offsetText =
        offsetMinutes === 0
          ? "בזמן"
          : offsetMinutes > 0
          ? `${offsetMinutes} דקות אחרי סוף זמן`
          : `${Math.abs(offsetMinutes)} דקות לפני סוף זמן`;

      return `✅ התזכורת "${typeNameHeb}" עודכנה בהצלחה.\n⏰ זמן: ${offsetText}`;
    } catch (error) {
      logger.error("Error updating reminder offset:", error);
      return "סליחה, אירעה שגיאה בעדכון התזכורת. נסה שוב.";
    }
  }

  /**
   * Gets reminder details by ID
   */
  async getReminder(phoneNumber: string, reminderId: string): Promise<ReminderSetting | null> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return null;
      }

      const allSettings = await mongoService.getReminderSettings(user.id);
      return allSettings.find((s) => s.id === reminderId) || null;
    } catch (error) {
      logger.error("Error getting reminder:", error);
      return null;
    }
  }

  private formatReminderTypeHebrew(type: ReminderType): string {
    const types: Record<ReminderType, string> = {
      tefillin: "הנחת תפילין",
      candle_lighting: "הדלקת נרות",
      shema: "זמן קריאת שמע",
      taara: "הפסק טהרה",
      clean_7: "שבעה נקיים",
    };
    return types[type] || type;
  }
}

export default new ReminderService();
