import supabaseService from '../../services/supabase';
import settingsCommand from './settings';
import messageTemplateService from '../../utils/messageTemplates';
import logger from '../../utils/logger';

export class MenuCommand {
  async showMenu(phoneNumber: string): Promise<string> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || user.status !== 'active') {
        return 'Please complete registration first. Send any message to get started.';
      }

      return `📱 *Reminders Bot Menu*\n\n` +
        `Available Reminder Types:\n\n` +
        `1️⃣ *Sunset Times* 🌅\n` +
        `   Get reminders for sunset times\n` +
        `   Command: /sunset [time offset]\n\n` +
        `2️⃣ *Candle Lighting* 🕯️\n` +
        `   Get reminders for Shabbat/Holiday candle lighting\n` +
        `   Command: /candles [time offset]\n\n` +
        `3️⃣ *Prayer Times* 🙏\n` +
        `   Get reminders for prayer times\n` +
        `   Command: /prayer [time offset]\n\n` +
        `Reminder Management:\n` +
        `📋 /reminders - View all your reminders\n` +
        `✏️ /edit <id> <time> - Edit a reminder\n` +
        `🗑️ /delete <id> - Delete a reminder\n\n` +
        `Other Commands:\n` +
        `⚙️ /settings - View your current settings\n` +
        `❓ /help - Get help and guidance\n` +
        `📝 /templates - View message templates\n\n` +
        `*Examples:*\n` +
        `• /sunset 30 (30 minutes before sunset)\n` +
        `• /candles 15 (15 minutes before candle lighting)\n` +
        `• /prayer 0 (at prayer time)\n` +
        `• /reminders (view all reminders)\n` +
        `• /edit <id> 45 (edit reminder to 45 min before)`;
    } catch (error) {
      logger.error('Error showing menu:', error);
      return 'Sorry, there was an error displaying the menu.';
    }
  }

  async showHelp(phoneNumber: string): Promise<string> {
    return `❓ *Help & Guidance*\n\n` +
      `*How to use the bot:*\n\n` +
      `1. Complete registration by providing your location\n` +
      `2. Choose reminder types from the menu\n` +
      `3. Set time offsets (e.g., "30 minutes before")\n` +
      `4. Receive automated reminders at your chosen times\n\n` +
      `*Setting Reminders:*\n` +
      `• Use /sunset, /candles, or /prayer followed by time offset\n` +
      `• Examples:\n` +
      `  - "/sunset 30" = 30 minutes before sunset\n` +
      `  - "/candles 0" = at candle lighting time\n` +
      `  - "/prayer 15" = 15 minutes before prayer\n\n` +
      `*Message Templates:*\n` +
      `All messages use pre-approved templates. Use /templates to view them.\n\n` +
      `*Need more help?*\n` +
      `Use /menu to see all available commands.`;
  }

  async showTemplates(phoneNumber: string): Promise<string> {
    try {
      const templates = messageTemplateService.getAllTemplates();
      
      let message = `📝 *Message Templates*\n\n`;
      message += `These are the pre-approved templates used for reminders:\n\n`;

      for (const template of templates) {
        message += `*${template.name}*\n`;
        message += `${template.content}\n\n`;
      }

      message += `\nTemplates are automatically formatted with the correct times and dates.`;

      return message;
    } catch (error) {
      logger.error('Error showing templates:', error);
      return 'Sorry, there was an error displaying templates.';
    }
  }

  async handleReminderTypeCommand(
    phoneNumber: string,
    reminderType: 'sunset' | 'candle_lighting' | 'prayer',
    timeInput?: string
  ): Promise<string> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || user.status !== 'active') {
        return 'Please complete registration first. Send any message to get started.';
      }

      if (!timeInput) {
        // Show current setting or prompt for time
        if (!user.id) {
          return 'User ID not found. Please contact support.';
        }
        const settings = await supabaseService.getReminderSettings(user.id);
        const setting = settings.find((s) => s.reminder_type === reminderType);
        
        if (setting) {
          const status = setting.enabled ? 'enabled' : 'disabled';
          const offsetText = setting.time_offset_minutes === 0
            ? 'at the time'
            : setting.time_offset_minutes > 0
            ? `${setting.time_offset_minutes} minutes after`
            : `${Math.abs(setting.time_offset_minutes)} minutes before`;
          
          return `${this.getReminderTypeName(reminderType)} reminder is currently ${status}.\nTime: ${offsetText}\n\nTo change, use: /${reminderType} [time offset]`;
        }
        
        return `To enable ${this.getReminderTypeName(reminderType)} reminders, specify a time offset.\nExample: /${reminderType} 30 (for 30 minutes before)`;
      }

      // Parse time offset
      const offsetMinutes = await settingsCommand.parseTimeOffset(timeInput);
      if (offsetMinutes === null) {
        return `Invalid time format. Please use:\n• A number (e.g., "30" for 30 minutes before)\n• "30 minutes before"\n• "15 minutes after"\n• "0" or "at" for at the time`;
      }

      // Enable the reminder
      return await settingsCommand.setReminderSetting(
        phoneNumber,
        reminderType,
        true,
        offsetMinutes
      );
    } catch (error) {
      logger.error('Error handling reminder type command:', error);
      return 'Sorry, there was an error processing your request.';
    }
  }

  private getReminderTypeName(type: 'sunset' | 'candle_lighting' | 'prayer'): string {
    const names = {
      sunset: 'Sunset',
      candle_lighting: 'Candle Lighting',
      prayer: 'Prayer Times',
    };
    return names[type] || type;
  }
}

export default new MenuCommand();

