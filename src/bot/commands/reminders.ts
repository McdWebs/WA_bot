// Database layer: use MongoDB instead of Supabase
import mongoService from "../../services/mongo";
import settingsCommand from "./settings";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import { ReminderType } from "../../types";

export class RemindersCommand {
  async listReminders(phoneNumber: string): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "Please complete registration first. Send any message to get started.";
      }

      const settings = await mongoService.getReminderSettings(user.id);

      if (settings.length === 0) {
        return "📭 You don't have any reminders yet.\n\nUse /menu to set up reminders.";
      }

      // If user has reminders, send a List Picker template with edit buttons
      // Limit to 5 reminders (max items in List Picker template)
      const remindersToShow = settings.slice(0, 5);

      // Create list items for the template
      // Each item needs: name, id, description
      // We'll use format: "edit_<reminder_id>" as the ID to identify which reminder to edit
      const listItems = remindersToShow.map((setting) => {
        const status = setting.enabled ? "✅" : "❌";
        const offsetText =
          setting.time_offset_minutes === 0
            ? "בזמן"
            : setting.time_offset_minutes > 0
            ? `${setting.time_offset_minutes} דקות אחרי`
            : `${Math.abs(setting.time_offset_minutes)} דקות לפני`;

        const typeName = this.formatReminderTypeHebrew(setting.reminder_type);
        const emoji = this.getReminderTypeEmoji(setting.reminder_type);

        return {
          name: `${emoji} ${typeName} - ${offsetText}`,
          id: `edit_${setting.id}`,
          desc: `לחץ לעריכה`,
        };
      });

      // Populate template variables (same structure as time_picker template)
      // Item 1: {{1}}=name, {{2}}=id, {{3}}=description
      // Item 2: {{4}}=name, {{5}}=id, {{6}}=description
      // etc.
      const templateVariables: Record<string, string> = {};
      listItems.forEach((item, index) => {
        const baseVar = index * 3 + 1; // 1, 4, 7, 10, 13
        templateVariables[String(baseVar)] = item.name;
        templateVariables[String(baseVar + 1)] = item.id;
        templateVariables[String(baseVar + 2)] = item.desc;
      });

      // Fill remaining slots if less than 5 items (to avoid template errors)
      const remainingSlots = 5 - listItems.length;
      for (let i = listItems.length; i < 5; i++) {
        const baseVar = i * 3 + 1;
        templateVariables[String(baseVar)] = "";
        templateVariables[String(baseVar + 1)] = "";
        templateVariables[String(baseVar + 2)] = "";
      }

      try {
        // Send the reminders list as a template (reusing time_picker template structure)
        await twilioService.sendTemplateMessage(
          phoneNumber,
          "timePicker", // Reuse the time_picker template structure
          templateVariables
        );

        return ""; // Empty string means we sent a template, not a text message
      } catch (error) {
        logger.error("Error sending reminders template:", error);
        // Fallback to text message
        let message = "📋 *Your Reminders:*\n\n";
        settings.forEach((setting, index) => {
          const status = setting.enabled ? "✅" : "❌";
          const offsetText =
            setting.time_offset_minutes === 0
              ? "at the time"
              : setting.time_offset_minutes > 0
              ? `${setting.time_offset_minutes} min after`
              : `${Math.abs(setting.time_offset_minutes)} min before`;

          const typeName = this.formatReminderType(setting.reminder_type);
          const emoji = this.getReminderTypeEmoji(setting.reminder_type);

          message += `${index + 1}. ${emoji} *${typeName}*\n`;
          message += `   ${status} ${offsetText}\n`;
          message += `   ID: \`${setting.id}\`\n\n`;
        });
        message += `*Commands:*\n`;
        message += `• /delete <id> - Delete a reminder\n`;
        message += `• /edit <id> <time> - Edit reminder time\n`;
        return message;
      }
    } catch (error) {
      logger.error("Error listing reminders:", error);
      return "Sorry, there was an error retrieving your reminders.";
    }
  }

  async deleteReminder(
    phoneNumber: string,
    reminderId: string
  ): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return "Please complete registration first. Send any message to get started.";
      }

      // Verify the reminder belongs to this user
      const allSettings = await mongoService.getReminderSettings(user.id);
      const reminderToDelete = allSettings.find((s) => s.id === reminderId);

      if (!reminderToDelete) {
        return "❌ Reminder not found. Use /reminders to see your reminders.";
      }

      if (reminderToDelete.user_id !== user.id) {
        return "❌ You can only delete your own reminders.";
      }

      await mongoService.deleteReminderSetting(reminderId);

      const typeName = this.formatReminderType(reminderToDelete.reminder_type);
      return `✅ Reminder deleted: ${typeName}`;
    } catch (error) {
      logger.error("Error deleting reminder:", error);
      return "Sorry, there was an error deleting the reminder.";
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
        return "❌ Reminder not found. Use /reminders to see your reminders.";
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

      const typeName = this.formatReminderType(reminderToEdit.reminder_type);
      const offsetText =
        offsetMinutes === 0
          ? "at the time"
          : offsetMinutes > 0
          ? `${offsetMinutes} minutes after`
          : `${Math.abs(offsetMinutes)} minutes before`;

      return `✅ Reminder updated: ${typeName}\nTime: ${offsetText}`;
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
