import supabaseService from '../../services/supabase';
import logger from '../../utils/logger';
import { ReminderType, ReminderSetting } from '../../types';

export class SettingsCommand {
  async getReminderSettings(phoneNumber: string): Promise<string> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return 'Please complete registration first. Send any message to get started.';
      }

      const settings = await supabaseService.getReminderSettings(user.id);
      
      if (settings.length === 0) {
        return 'You don\'t have any reminder settings yet. Use /menu to set up reminders.';
      }

      let message = '📋 Your Reminder Settings:\n\n';
      
      for (const setting of settings) {
        const status = setting.enabled ? '✅ Enabled' : '❌ Disabled';
        const offsetText = setting.time_offset_minutes === 0
          ? 'at the time'
          : setting.time_offset_minutes > 0
          ? `${setting.time_offset_minutes} minutes after`
          : `${Math.abs(setting.time_offset_minutes)} minutes before`;
        
        message += `${this.getReminderTypeEmoji(setting.reminder_type)} ${this.formatReminderType(setting.reminder_type)}: ${status}\n`;
        message += `   Time: ${offsetText}\n\n`;
      }

      return message;
    } catch (error) {
      logger.error('Error getting reminder settings:', error);
      return 'Sorry, there was an error retrieving your settings.';
    }
  }

  async setReminderSetting(
    phoneNumber: string,
    reminderType: ReminderType,
    enabled: boolean,
    offsetMinutes: number = 0
  ): Promise<string> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        return 'Please complete registration first. Send any message to get started.';
      }

      const setting: Omit<ReminderSetting, 'id' | 'created_at' | 'updated_at'> = {
        user_id: user.id,
        reminder_type: reminderType,
        enabled,
        time_offset_minutes: offsetMinutes,
      };

      await supabaseService.upsertReminderSetting(setting);

      const status = enabled ? 'enabled' : 'disabled';
      const offsetText = offsetMinutes === 0
        ? 'at the time'
        : offsetMinutes > 0
        ? `${offsetMinutes} minutes after`
        : `${Math.abs(offsetMinutes)} minutes before`;

      return `✅ ${this.formatReminderType(reminderType)} reminder ${status}.\nTime: ${offsetText}`;
    } catch (error) {
      logger.error('Error setting reminder:', error);
      return 'Sorry, there was an error saving your setting.';
    }
  }

  async parseTimeOffset(input: string): Promise<number | null> {
    // Parse inputs like "30 minutes before", "15 min after", "at time", etc.
    const normalized = input.toLowerCase().trim();
    
    if (normalized.includes('at') || normalized === '0') {
      return 0;
    }

    const beforeMatch = normalized.match(/(\d+)\s*(?:min|minute|minutes)?\s*before/);
    if (beforeMatch) {
      return -parseInt(beforeMatch[1], 10);
    }

    const afterMatch = normalized.match(/(\d+)\s*(?:min|minute|minutes)?\s*after/);
    if (afterMatch) {
      return parseInt(afterMatch[1], 10);
    }

    // Try to parse as just a number (assume minutes before)
    const numberMatch = normalized.match(/^(\d+)$/);
    if (numberMatch) {
      return -parseInt(numberMatch[1], 10);
    }

    return null;
  }

  private formatReminderType(type: ReminderType): string {
    const types: Record<ReminderType, string> = {
      sunset: 'Sunset',
      candle_lighting: 'Candle Lighting',
      prayer: 'Prayer Times',
    };
    return types[type] || type;
  }

  private getReminderTypeEmoji(type: ReminderType): string {
    const emojis: Record<ReminderType, string> = {
      sunset: '🌅',
      candle_lighting: '🕯️',
      prayer: '🙏',
    };
    return emojis[type] || '⏰';
  }
}

export default new SettingsCommand();

