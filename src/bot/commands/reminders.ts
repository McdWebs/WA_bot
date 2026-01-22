// Database layer: use MongoDB instead of Supabase
import mongoService from "../../services/mongo";
import settingsCommand from "./settings";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import { ReminderType } from "../../types";

// Track reminder list mapping: phoneNumber -> { index: reminderId }
// Used to map user's number selection (1, 2, 3) to actual reminder IDs
const reminderListMapping = new Map<string, Map<number, string>>();

export class RemindersCommand {
  /**
   * Lists all reminders for a user as a plain text message (NO TEMPLATES)
   * Stores mapping of list numbers to reminder IDs for later selection
   */
  async listReminders(phoneNumber: string): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "אנא השלם/י רישום קודם. שלח/י כל הודעה כדי להתחיל.";
      }

      const settings = await mongoService.getReminderSettings(user.id);

      if (settings.length === 0) {
        return "📭 אין לך תזכורות עדיין.\n\nהשתמש/י בתפריט כדי להוסיף תזכורת חדשה.";
      }

      // Build the reminder list text message
      let message = "📋 התזכורות שלך:\n\n";

      // Create mapping: list number -> reminder ID
      const mapping = new Map<number, string>();

      settings.forEach((setting, index) => {
        const listNumber = index + 1;
        const typeNameHeb = this.formatReminderTypeHebrew(setting.reminder_type);
        const minutes = setting.time_offset_minutes;

        // Format time offset in Hebrew
        let timeText: string;
        if (minutes === 0) {
          timeText = "בזמן";
        } else if (minutes < 0) {
          timeText = `${Math.abs(minutes)} דקות לפני סוף זמן`;
        } else {
          timeText = `${minutes} דקות אחרי סוף זמן`;
        }

        message += `${listNumber}️⃣ ${typeNameHeb} – ${timeText}\n`;

        // Store mapping for this reminder
        mapping.set(listNumber, setting.id!);
      });

      // Store the mapping for this user
      reminderListMapping.set(phoneNumber, mapping);

      message += `\nמה תרצה לעשות?\n\n`;
      message += `שלח/י מספר תזכורת (1-${settings.length}) לעריכה או מחיקה.\n`;
      message += `או שלח/י:\n`;
      message += `➕ *תזכורת חדשה* - להוספת תזכורת\n`;
      message += `🔙 *חזרה* - חזרה לתפריט הראשי`;

      return message;
    } catch (error) {
      logger.error("Error listing reminders:", error);
      return "סליחה, אירעה שגיאה בטעינת התזכורות. נסה שוב מאוחר יותר.";
    }
  }

  /**
   * Gets the reminder ID for a user's number selection
   */
  getReminderIdByNumber(phoneNumber: string, number: number): string | null {
    const mapping = reminderListMapping.get(phoneNumber);
    if (!mapping) {
      return null;
    }
    return mapping.get(number) || null;
  }

  /**
   * Clears the reminder list mapping for a user
   */
  clearReminderMapping(phoneNumber: string): void {
    reminderListMapping.delete(phoneNumber);
  }

  async deleteReminder(
    phoneNumber: string,
    reminderId: string
  ): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "אנא השלם/י רישום קודם. שלח/י כל הודעה כדי להתחיל.";
      }

      // Verify the reminder belongs to this user
      const allSettings = await mongoService.getReminderSettings(user.id);
      const reminderToDelete = allSettings.find((s) => s.id === reminderId);

      if (!reminderToDelete) {
        return "❌ תזכורת לא נמצאה. בחר/י תזכורת מהרשימה בתפריט.";
      }

      if (reminderToDelete.user_id !== user.id) {
        return "❌ ניתן למחוק רק את התזכורות שלך.";
      }

      await mongoService.deleteReminderSetting(reminderId);

      const typeNameHeb = this.formatReminderTypeHebrew(reminderToDelete.reminder_type);
      return `✅ התזכורת "${typeNameHeb}" נמחקה בהצלחה.`;
    } catch (error) {
      logger.error("Error deleting reminder:", error);
      return "סליחה, אירעה שגיאה במחיקת התזכורת. נסה שוב.";
    }
  }

  async editReminder(
    phoneNumber: string,
    reminderId: string,
    timeInput: string
  ): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "Please complete registration first. Send any message to get started.";
      }

      // Find the reminder
      const allSettings = await mongoService.getReminderSettings(user.id);
      const reminderToEdit = allSettings.find((s) => s.id === reminderId);

      if (!reminderToEdit) {
        return "❌ Reminder not found. בחר/י תזכורת מהרשימה בתפריט.";
      }

      if (reminderToEdit.user_id !== user.id) {
        return "❌ You can only edit your own reminders.";
      }

      // Parse time offset
      const offsetMinutes = await settingsCommand.parseTimeOffset(timeInput);
      if (offsetMinutes === null) {
        return `Invalid time format. Please use:\n• A number (e.g., "30" for 30 minutes before)\n• "30 minutes before"\n• "15 minutes after"\n• "0" or "at" for at the time`;
      }

      // Update the reminder
      await mongoService.upsertReminderSetting({
        user_id: user.id,
        reminder_type: reminderToEdit.reminder_type,
        enabled: true,
        time_offset_minutes: offsetMinutes,
      });

      const typeNameHeb = this.formatReminderTypeHebrew(reminderToEdit.reminder_type);
      const offsetText =
        offsetMinutes === 0
          ? "בזמן"
          : offsetMinutes > 0
          ? `${offsetMinutes} דקות אחרי סוף זמן`
          : `${Math.abs(offsetMinutes)} דקות לפני סוף זמן`;

      return `✅ התזכורת "${typeNameHeb}" עודכנה בהצלחה.\n⏰ זמן: ${offsetText}`;
    } catch (error) {
      logger.error("Error editing reminder:", error);
      return "Sorry, there was an error updating the reminder.";
    }
  }

  private formatReminderType(type: ReminderType): string {
    const types: Record<ReminderType, string> = {
      tefillin: "Tefilin",
      candle_lighting: "Candle Lighting",
      shema: "Shema Time",
    };
    return types[type] || type;
  }

  private getReminderTypeEmoji(type: ReminderType): string {
    const emojis: Record<ReminderType, string> = {
      tefillin: "📿",
      candle_lighting: "🕯️",
      shema: "📖",
    };
    return emojis[type] || "⏰";
  }

  private formatReminderTypeHebrew(type: ReminderType): string {
    const types: Record<ReminderType, string> = {
      tefillin: "הנחת תפילין",
      candle_lighting: "הדלקת נרות",
      shema: "זמן קריאת שמע",
    };
    return types[type] || type;
  }
}

export default new RemindersCommand();
