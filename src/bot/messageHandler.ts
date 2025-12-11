import registrationCommand from './commands/registration';
import menuCommand from './commands/menu';
import supabaseService from '../services/supabase';
import hebcalService from '../services/hebcal';
import twilioService from '../services/twilio';
import logger from '../utils/logger';

// Track which reminder is being edited: phoneNumber -> reminderId
const editingReminders = new Map<string, string>();

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
      logger.info(`Detected button click pattern: "${normalized}"`);
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
    
    const isMatch = buttonPatterns.some(pattern => pattern.test(normalized));
    if (isMatch) {
      logger.info(`Detected button click pattern: "${normalized}"`);
    }
    return isMatch;
  }

  async handleIncomingMessage(phoneNumber: string, messageBody: string): Promise<string> {
    try {
      const normalizedMessage = messageBody.trim().toLowerCase();
      
      // Handle commands
      if (normalizedMessage.startsWith('/')) {
        return await this.handleCommand(phoneNumber, normalizedMessage);
      }

      // Simple welcome message for any incoming message
      return 'Hi, this is a reminder bot';
    } catch (error) {
      logger.error('Error handling incoming message:', error);
      return 'Sorry, there was an error processing your message. Please try again.';
    }
  }

  private async handleCommand(phoneNumber: string, command: string): Promise<string> {
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case '/start':
      case '/menu':
        return await menuCommand.showMenu(phoneNumber);

      case '/help':
        return await menuCommand.showHelp(phoneNumber);

      case '/templates':
        return await menuCommand.showTemplates(phoneNumber);

      case '/settings':
        const settingsCommand = (await import('./commands/settings')).default;
        return await settingsCommand.getReminderSettings(phoneNumber);

      case '/sunset':
        return await menuCommand.handleReminderTypeCommand(
          phoneNumber,
          'sunset',
          args.join(' ')
        );

      case '/candles':
      case '/candle':
      case '/candlelighting':
        return await menuCommand.handleReminderTypeCommand(
          phoneNumber,
          'candle_lighting',
          args.join(' ')
        );

      case '/prayer':
      case '/prayers':
        return await menuCommand.handleReminderTypeCommand(
          phoneNumber,
          'prayer',
          args.join(' ')
        );

      case '/reminders':
        const remindersCommand = (await import('./commands/reminders')).default;
        const remindersResult = await remindersCommand.listReminders(phoneNumber);
        // If empty string, template was sent, return a confirmation message
        if (remindersResult === '') {
          return '📋 Sending your reminders list...';
        }
        return remindersResult;

      case '/delete':
        if (args.length === 0) {
          return 'Please provide a reminder ID. Use /reminders to see your reminders.';
        }
        const deleteCommand = (await import('./commands/reminders')).default;
        return await deleteCommand.deleteReminder(phoneNumber, args[0]);

      case '/edit':
        if (args.length < 2) {
          return 'Please provide a reminder ID and time. Example: /edit <id> 30';
        }
        const editCommand = (await import('./commands/reminders')).default;
        return await editCommand.editReminder(phoneNumber, args[0], args.slice(1).join(' '));

      default:
        return 'Unknown command. Use /menu to see available commands.';
    }
  }

  async handleInteractiveButton(phoneNumber: string, buttonIdentifier: string): Promise<void> {
    try {
      logger.info(`🔘 Handling interactive button click from ${phoneNumber}: "${buttonIdentifier}"`);

      // CRITICAL: Only process if this is a valid button identifier
      // Reject empty or invalid identifiers to prevent accidental triggers
      if (!buttonIdentifier || buttonIdentifier.trim().length === 0) {
        logger.warn(`⚠️ Invalid button identifier - ignoring: "${buttonIdentifier}"`);
        return;
      }

      // Get user data
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || user.status !== 'active') {
        logger.warn(`User ${phoneNumber} not found or not active - cannot handle button click`);
        return;
      }

      // Normalize button identifier
      const normalizedButton = buttonIdentifier.toLowerCase().trim();
      const cleanButton = normalizedButton.replace(/^[1-9][\.:]\s*/, '').replace(/^[1-9]\s*/, '');
      
      logger.info(`Button identifier: "${buttonIdentifier}", normalized: "${normalizedButton}", clean: "${cleanButton}"`);
      
      // Check if this is button "1" from welcome template (first step: select reminder type)
      const isFirstMenuItem = 
        normalizedButton === '1' ||
        /^1[\.:]?$/.test(normalizedButton) ||
        normalizedButton.startsWith('1.') ||
        normalizedButton.startsWith('1:');

      // Check if this is an edit button from reminders list (format: "edit_<reminder_id>")
      const isEditReminderButton = normalizedButton.startsWith('edit_');
      
      // Check if this is a time selection from time_picker template (second step: select time range)
      // Time picker sends IDs: "0", "15", "30", "45", "60"
      const isTimePickerSelection = 
        normalizedButton === '0' ||
        normalizedButton === '15' ||
        normalizedButton === '30' ||
        normalizedButton === '45' ||
        normalizedButton === '60' ||
        /^(0|15|30|45|60)$/.test(normalizedButton);

      if (isFirstMenuItem) {
        // Step 1: User selected reminder type (Sunset) → send time picker template
        logger.info(`✅ Step 1: Detected first menu item (Sunset) - sending time picker template`);
        await this.sendTimePickerForSunset(phoneNumber, user.location || 'Jerusalem');
      } else if (isEditReminderButton) {
        // User clicked "Edit" on a reminder → store reminder ID and send time picker template
        const reminderId = normalizedButton.replace('edit_', '');
        logger.info(`✅ Detected edit reminder button for reminder ID: ${reminderId}`);
        
        // Store which reminder is being edited
        editingReminders.set(phoneNumber, reminderId);
        
        // Send time picker template
        await this.sendTimePickerForSunset(phoneNumber, user.location || 'Jerusalem');
      } else if (isTimePickerSelection) {
        // Step 2: User selected time range → check if editing existing reminder or creating new
        const editingReminderId = editingReminders.get(phoneNumber);
        
        if (editingReminderId) {
          // We're editing an existing reminder
          logger.info(`✅ Editing existing reminder ${editingReminderId} with time selection: ${buttonIdentifier}`);
          await this.updateReminderFromTimePicker(phoneNumber, editingReminderId, buttonIdentifier, user.location || 'Jerusalem');
          // Clear the editing state
          editingReminders.delete(phoneNumber);
        } else {
          // Creating a new reminder (original flow)
          logger.info(`✅ Step 2: Detected time picker selection "${buttonIdentifier}" - sending complete template`);
          await this.sendCompleteTemplate(phoneNumber, buttonIdentifier, user.location || 'Jerusalem');
        }
      } else {
        logger.info(`⚠️ Button "${buttonIdentifier}" is not recognized - no action taken`);
      }
    } catch (error) {
      logger.error(`❌ Error handling interactive button for ${phoneNumber}:`, error);
    }
  }

  /**
   * Infers location from phone number country code
   */
  private inferLocationFromPhoneNumber(phoneNumber: string): string {
    // Remove any non-digit characters except +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // Country code to location mapping (for Hebrew calendar, prioritize Israel)
    const countryCodeMap: Record<string, string> = {
      '972': 'Jerusalem', // Israel
      '1': 'New York', // USA/Canada
      '44': 'London', // UK
      '33': 'Paris', // France
      '49': 'Berlin', // Germany
      '7': 'Moscow', // Russia
      '61': 'Sydney', // Australia
      '81': 'Tokyo', // Japan
    };
    
    // Extract country code (first 1-3 digits after +)
    for (const [code, city] of Object.entries(countryCodeMap)) {
      if (cleaned.startsWith(`+${code}`) || cleaned.startsWith(code)) {
        logger.info(`Inferred location "${city}" from phone number country code: ${code}`);
        return city;
      }
    }
    
    // Default to Jerusalem for Hebrew calendar
    logger.info(`Using default location "Jerusalem" for phone number: ${phoneNumber}`);
    return 'Jerusalem';
  }

  private async sendTimePickerForSunset(phoneNumber: string, location: string): Promise<void> {
    try {
      logger.info(`🌅 Preparing to send time picker template to ${phoneNumber} for location: ${location}`);
      
      // Validate location - if it's invalid or too short, infer from phone number
      let validLocation = location;
      if (!location || location.length < 2 || location.length > 50) {
        logger.warn(`Invalid location "${location}", inferring from phone number`);
        validLocation = this.inferLocationFromPhoneNumber(phoneNumber);
      }
      
      // Try to get sunset data with the location
      let sunsetData = await hebcalService.getSunsetData(validLocation);
      
      // If that fails, try with inferred location from phone number (if different)
      if (!sunsetData) {
        const inferredLocation = this.inferLocationFromPhoneNumber(phoneNumber);
        if (inferredLocation !== validLocation) {
          logger.info(`Trying inferred location "${inferredLocation}" as fallback`);
          sunsetData = await hebcalService.getSunsetData(inferredLocation);
          if (sunsetData) {
            validLocation = inferredLocation;
          }
        }
        
        // Final fallback to Jerusalem if still no data
        if (!sunsetData && validLocation !== 'Jerusalem') {
          logger.info(`Trying "Jerusalem" as final fallback`);
          sunsetData = await hebcalService.getSunsetData('Jerusalem');
          if (sunsetData) {
            validLocation = 'Jerusalem';
          }
        }
      }
      
      if (!sunsetData) {
        logger.warn(`No sunset data found for location: ${validLocation}`);
        await twilioService.sendMessage(
          phoneNumber,
          'Sorry, I could not retrieve sunset time for your location. Please try again later.'
        );
        return;
      }

      // Prepare template variables for List Picker template
      // The template has 5 list items, each with: name ({{1,4,7,10,13}}), id ({{2,5,8,11,14}}), description ({{3,6,9,12,15}})
      // We'll create time options based on the sunset time
      const sunsetTime = sunsetData.sunset || '18:00';
      const [hours, minutes] = sunsetTime.split(':').map(Number);
      
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
        
        const result = `${String(reminderHours).padStart(2, '0')}:${String(reminderMins).padStart(2, '0')}`;
        logger.info(`Calculated time: ${sunsetTime} - ${minutesBefore} minutes = ${result}`);
        return result;
      };
      
      // Create time options (at sunset, 15 min before, 30 min before, 45 min before, 1 hour before)
      const timeOptions = [
        { 
          name: `בזמן השקיעה (${sunsetTime})`, 
          id: '0', 
          desc: `תזכורת בדיוק בזמן השקיעה` 
        },
        { 
          name: `15 דקות לפני (${calculateTimeBefore(15)})`, 
          id: '15', 
          desc: `תזכורת 15 דקות לפני השקיעה` 
        },
        { 
          name: `30 דקות לפני (${calculateTimeBefore(30)})`, 
          id: '30', 
          desc: `תזכורת 30 דקות לפני השקיעה` 
        },
        { 
          name: `45 דקות לפני (${calculateTimeBefore(45)})`, 
          id: '45', 
          desc: `תזכורת 45 דקות לפני השקיעה` 
        },
        { 
          name: `שעה לפני (${calculateTimeBefore(60)})`, 
          id: '60', 
          desc: `תזכורת שעה לפני השקיעה` 
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
        templateVariables[String(baseVar)] = option.name;      // Item name
        templateVariables[String(baseVar + 1)] = option.id;     // Item ID
        templateVariables[String(baseVar + 2)] = option.desc;   // Item description
      });

      try {
        // Try sending the time picker template with variables
        await twilioService.sendTemplateMessage(
          phoneNumber,
          'timePicker', // This will use config.templates.timePicker
          templateVariables
        );

        logger.info(`Time picker template sent to ${phoneNumber} for sunset time: ${sunsetData.sunset}`);
      } catch (templateError: any) {
        // If template with variables fails, try without variables
        if (templateError.code === 21656) {
          logger.warn(`Template variables error (21656) - trying without variables or sending formatted message`);
          
          try {
            // Try sending template without variables
            await twilioService.sendTemplateMessage(phoneNumber, 'timePicker');
            logger.info(`Time picker template sent without variables to ${phoneNumber}`);
          } catch (noVarError) {
            // Fallback: Send formatted plain text message
            const formattedMessage = 
              `🌅 Sunset Time Information\n\n` +
              `📍 Location: ${location}\n` +
              `📅 Date: ${sunsetData.date}\n` +
              `⏰ Sunset: ${sunsetData.sunset}\n` +
              (sunsetData.candle_lighting ? `🕯️ Candle Lighting: ${sunsetData.candle_lighting}\n` : '');
            
            await twilioService.sendMessage(phoneNumber, formattedMessage);
            logger.info(`Sent formatted message as fallback to ${phoneNumber}`);
          }
        } else {
          throw templateError;
        }
      }
    } catch (error) {
      logger.error(`Error sending time picker for sunset to ${phoneNumber}:`, error);
      throw error;
    }
  }

  /**
   * Sends the complete template after user selects a time range
   */
  private async sendCompleteTemplate(
    phoneNumber: string, 
    selectedTimeId: string, 
    location: string
  ): Promise<void> {
    try {
      logger.info(`✅ Preparing to send complete template to ${phoneNumber} for time selection: ${selectedTimeId}`);
      
      // Get user to save reminder setting
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        logger.error(`User not found or not active: ${phoneNumber}`);
        await twilioService.sendMessage(
          phoneNumber,
          'Sorry, we could not find your account. Please complete registration first.'
        );
        return;
      }
      
      // Get sunset data to show in the complete template
      let validLocation = location;
      if (!location || location.length < 2 || location.length > 50) {
        validLocation = this.inferLocationFromPhoneNumber(phoneNumber);
      }
      
      // Update user location if it's different
      if (user.location !== validLocation) {
        logger.info(`Updating user location from "${user.location}" to "${validLocation}"`);
        await supabaseService.updateUser(phoneNumber, { location: validLocation });
      }
      
      let sunsetData = await hebcalService.getSunsetData(validLocation);
      if (!sunsetData) {
        // Try fallback locations
        const inferredLocation = this.inferLocationFromPhoneNumber(phoneNumber);
        if (inferredLocation !== validLocation) {
          const fallbackData = await hebcalService.getSunsetData(inferredLocation);
          if (fallbackData) {
            sunsetData = fallbackData;
            validLocation = inferredLocation;
          }
        }
        
        if (!sunsetData) {
          const jerusalemData = await hebcalService.getSunsetData('Jerusalem');
          if (jerusalemData) {
            sunsetData = jerusalemData;
            validLocation = 'Jerusalem';
          }
        }
      }

      // Map time ID to time offset in minutes (negative = before sunset)
      // '0' = at sunset (0 minutes), '15' = 15 minutes before (-15), etc.
      const timeOffsetMap: Record<string, number> = {
        '0': 0,      // At sunset
        '15': -15,   // 15 minutes before
        '30': -30,   // 30 minutes before
        '45': -45,   // 45 minutes before
        '60': -60,   // 60 minutes before (1 hour)
      };

      const timeOffsetMinutes = timeOffsetMap[selectedTimeId] ?? 0;

      // Map time ID to human-readable description
      const timeDescriptions: Record<string, string> = {
        '0': 'בזמן השקיעה',
        '15': '15 דקות לפני השקיעה',
        '30': '30 דקות לפני השקיעה',
        '45': '45 דקות לפני השקיעה',
        '60': 'שעה לפני השקיעה',
      };

      const timeDescription = timeDescriptions[selectedTimeId] || `תזכורת ${selectedTimeId} דקות לפני השקיעה`;
      const sunsetTime = sunsetData?.sunset || '18:00';

      // Save reminder setting to database (for new reminders)
      try {
        const reminderSetting = {
          user_id: user.id,
          reminder_type: 'sunset' as const,
          enabled: true,
          time_offset_minutes: timeOffsetMinutes,
        };

        await supabaseService.upsertReminderSetting(reminderSetting);
        logger.info(`✅ Reminder setting saved: sunset reminder enabled with offset ${timeOffsetMinutes} minutes for user ${phoneNumber}`);
      } catch (saveError) {
        logger.error(`❌ Error saving reminder setting for ${phoneNumber}:`, saveError);
        // Continue anyway - still send the complete template
      }

      // Prepare template variables for complete template
      // Note: Adjust variable names based on your actual complete template structure
      // Common structure might be: {{1}}=reminder type, {{2}}=time, {{3}}=location, etc.
      const templateVariables: Record<string, string> = {
        '1': 'זמני שקיעה', // Reminder type
        '2': timeDescription, // Selected time description
        '3': sunsetTime, // Sunset time
        '4': validLocation, // Location
      };

      try {
        await twilioService.sendTemplateMessage(
          phoneNumber,
          'complete',
          templateVariables
        );
        logger.info(`Complete template sent to ${phoneNumber} for time selection: ${selectedTimeId}`);
      } catch (templateError: any) {
        if (templateError.code === 21656) {
          logger.warn(`Template variables error (21656) - trying without variables`);
          try {
            await twilioService.sendTemplateMessage(phoneNumber, 'complete');
            logger.info(`Complete template sent without variables to ${phoneNumber}`);
          } catch (noVarError) {
            // Fallback to plain text message
            const formattedMessage =
              `✅ התזכורת הוגדרה בהצלחה!\n\n` +
              `📌 סוג: זמני שקיעה\n` +
              `⏰ זמן: ${timeDescription}\n` +
              `🌅 שעת שקיעה: ${sunsetTime}\n` +
              `📍 מיקום: ${validLocation}\n\n` +
              `תזכורת תשלח אליך בזמן שנבחר.`;
            
            await twilioService.sendMessage(phoneNumber, formattedMessage);
            logger.info(`Sent formatted message as fallback to ${phoneNumber}`);
          }
        } else {
          throw templateError;
        }
      }
      
      // Confirm reminder is saved and will be sent daily
      logger.info(`✅ Reminder configured successfully for ${phoneNumber}: ${timeDescription} (offset: ${timeOffsetMinutes} minutes)`);
    } catch (error) {
      logger.error(`Error sending complete template to ${phoneNumber}:`, error);
      throw error;
    }
  }

  /**
   * Updates an existing reminder when user selects a time from the time picker
   */
  private async updateReminderFromTimePicker(
    phoneNumber: string,
    reminderId: string,
    selectedTimeId: string,
    location: string
  ): Promise<void> {
    try {
      logger.info(`🔄 Updating reminder ${reminderId} for ${phoneNumber} with time selection: ${selectedTimeId}`);
      
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        logger.error(`User not found or not active: ${phoneNumber}`);
        await twilioService.sendMessage(
          phoneNumber,
          'Sorry, we could not find your account. Please complete registration first.'
        );
        return;
      }

      // Get the reminder to update
      const allSettings = await supabaseService.getReminderSettings(user.id);
      const reminderToUpdate = allSettings.find(s => s.id === reminderId);

      if (!reminderToUpdate) {
        logger.error(`Reminder ${reminderId} not found for user ${phoneNumber}`);
        await twilioService.sendMessage(
          phoneNumber,
          '❌ Reminder not found. Please try again.'
        );
        return;
      }

      // Map time ID to time offset in minutes (negative = before sunset)
      const timeOffsetMap: Record<string, number> = {
        '0': 0,      // At sunset
        '15': -15,   // 15 minutes before
        '30': -30,   // 30 minutes before
        '45': -45,   // 45 minutes before
        '60': -60,   // 60 minutes before (1 hour)
      };

      const timeOffsetMinutes = timeOffsetMap[selectedTimeId] ?? 0;

      // Update the reminder
      await supabaseService.upsertReminderSetting({
        user_id: user.id,
        reminder_type: reminderToUpdate.reminder_type,
        enabled: true,
        time_offset_minutes: timeOffsetMinutes,
      });

      // Get sunset data for confirmation message
      let validLocation = location;
      if (!location || location.length < 2 || location.length > 50) {
        validLocation = this.inferLocationFromPhoneNumber(phoneNumber);
      }

      let sunsetData = await hebcalService.getSunsetData(validLocation);
      if (!sunsetData) {
        sunsetData = await hebcalService.getSunsetData('Jerusalem');
      }

      const timeDescriptions: Record<string, string> = {
        '0': 'בזמן השקיעה',
        '15': '15 דקות לפני השקיעה',
        '30': '30 דקות לפני השקיעה',
        '45': '45 דקות לפני השקיעה',
        '60': 'שעה לפני השקיעה',
      };

      const timeDescription = timeDescriptions[selectedTimeId] || `תזכורת ${selectedTimeId} דקות לפני השקיעה`;
      const sunsetTime = sunsetData?.sunset || '18:00';

      // Send confirmation message
      const confirmationMessage = 
        `✅ התזכורת עודכנה בהצלחה!\n\n` +
        `📋 סוג: ${this.getReminderTypeNameHebrew(reminderToUpdate.reminder_type)}\n` +
        `⏰ זמן: ${timeDescription}\n` +
        `🌅 שעת שקיעה: ${sunsetTime}\n` +
        `📍 מיקום: ${validLocation}`;

      await twilioService.sendMessage(phoneNumber, confirmationMessage);
      logger.info(`✅ Reminder ${reminderId} updated successfully for ${phoneNumber}`);
    } catch (error) {
      logger.error(`❌ Error updating reminder ${reminderId} for ${phoneNumber}:`, error);
      await twilioService.sendMessage(
        phoneNumber,
        'Sorry, there was an error updating your reminder. Please try again.'
      );
    }
  }

  private getReminderTypeNameHebrew(type: string): string {
    const types: Record<string, string> = {
      sunset: 'זמני שקיעה',
      candle_lighting: 'הדלקת נרות',
      prayer: 'זמני תפילה',
    };
    return types[type] || type;
  }
}

export default new MessageHandler();

