import cron from 'node-cron';
import supabaseService from '../services/supabase';
import hebcalService from '../services/hebcal';
import twilioService from '../services/twilio';
import timezoneService from '../utils/timezone';
import messageTemplateService from '../utils/messageTemplates';
import logger from '../utils/logger';
import { ReminderSetting, User } from '../types';

export class ReminderScheduler {
  private isRunning = false;

  start(): void {
    if (this.isRunning) {
      logger.warn('Reminder scheduler is already running');
      return;
    }

    // Run every minute to check for reminders
    cron.schedule('* * * * *', async () => {
      await this.checkAndSendReminders();
    });

    this.isRunning = true;
    logger.info('Reminder scheduler started');
  }

  private async checkAndSendReminders(): Promise<void> {
    try {
      // Get all active reminder settings with user data
      const settings = await supabaseService.getAllActiveReminderSettings();
      
      if (settings.length === 0) {
        return;
      }

      // Group settings by user
      const userSettingsMap = new Map<string, { user: User; settings: ReminderSetting[] }>();
      
      for (const setting of settings) {
        // Extract user from joined data
        const user = setting.users;
        if (!user) continue;

        if (!userSettingsMap.has(user.phone_number)) {
          userSettingsMap.set(user.phone_number, { user, settings: [] });
        }
        
        // Extract just the ReminderSetting part (without users)
        const { users, ...reminderSetting } = setting;
        userSettingsMap.get(user.phone_number)!.settings.push(reminderSetting);
      }

      // Check each user's reminders
      for (const [phoneNumber, { user, settings: userSettings }] of userSettingsMap) {
        await this.checkUserReminders(user, userSettings);
      }
    } catch (error) {
      logger.error('Error checking reminders:', error);
    }
  }

  private async checkUserReminders(user: User, settings: ReminderSetting[]): Promise<void> {
    try {
      const location = user.location || 'Jerusalem';
      const timezone = user.timezone || 'Asia/Jerusalem';
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];

      // Get today's Hebrew calendar data
      const hebcalData = await hebcalService.getHebcalData(location, todayStr);
      
      for (const setting of settings) {
        if (!setting.enabled) continue;

        const shouldSend = await this.shouldSendReminder(
          setting,
          user,
          hebcalData,
          todayStr
        );

        if (shouldSend) {
          await this.sendReminder(user, setting, hebcalData, location);
        }
      }
    } catch (error) {
      logger.error(`Error checking reminders for user ${user.phone_number}:`, error);
    }
  }

  private async shouldSendReminder(
    setting: ReminderSetting,
    user: User,
    hebcalData: any,
    dateStr: string
  ): Promise<boolean> {
    try {
      let eventTime: string | null = null;

      // Get event time based on reminder type
      switch (setting.reminder_type) {
        case 'sunset':
          eventTime = await hebcalService.getSunsetTime(user.location || 'Jerusalem', dateStr);
          break;
        case 'candle_lighting':
          eventTime = await hebcalService.getCandleLightingTime(
            user.location || 'Jerusalem',
            dateStr
          );
          break;
        case 'prayer':
          // Prayer times not yet implemented
          return false;
        default:
          return false;
      }

      if (!eventTime) {
        return false;
      }

      // Calculate reminder time
      const reminderTime = timezoneService.calculateReminderTime(
        eventTime,
        setting.time_offset_minutes
      );

      // Convert to user's timezone if needed
      const userTimezone = user.timezone || 'Asia/Jerusalem';
      const locationTimezone = hebcalData.location?.tzid || 'Asia/Jerusalem';
      
      let finalReminderTime = reminderTime;
      if (locationTimezone !== userTimezone) {
        finalReminderTime = timezoneService.convertTimeToTimezone(
          reminderTime,
          locationTimezone,
          userTimezone
        );
      }

      // Check if it's time to send
      return timezoneService.isTimeToSendReminder(finalReminderTime, userTimezone);
    } catch (error) {
      logger.error('Error checking if should send reminder:', error);
      return false;
    }
  }

  private async sendReminder(
    user: User,
    setting: ReminderSetting,
    hebcalData: any,
    location: string
  ): Promise<void> {
    try {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      let eventTime: string | null = null;
      let additionalData: Record<string, string> = {};

      // Get event time
      switch (setting.reminder_type) {
        case 'sunset':
          eventTime = await hebcalService.getSunsetTime(location, todayStr);
          break;
        case 'candle_lighting':
          eventTime = await hebcalService.getCandleLightingTime(location, todayStr);
          break;
        case 'prayer':
          return; // Not implemented yet
      }

      if (!eventTime) {
        logger.warn(`No event time found for ${setting.reminder_type} on ${todayStr}`);
        return;
      }

      // Format message
      const message = messageTemplateService.formatReminderMessage(
        setting.reminder_type,
        eventTime,
        additionalData
      );

      // Send via Twilio
      await twilioService.sendMessage(user.phone_number, message);
      
      logger.info(`Reminder sent to ${user.phone_number} for ${setting.reminder_type}`);
    } catch (error) {
      logger.error(`Error sending reminder to ${user.phone_number}:`, error);
    }
  }

  stop(): void {
    this.isRunning = false;
    logger.info('Reminder scheduler stopped');
  }
}

export default new ReminderScheduler();

