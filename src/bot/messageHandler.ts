import registrationCommand from "./commands/registration";
import menuCommand from "./commands/menu";
import supabaseService from "../services/supabase";
import hebcalService from "../services/hebcal";
import twilioService from "../services/twilio";
import logger from "../utils/logger";
import { Gender, ReminderType } from "../types";

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

    const isMatch = buttonPatterns.some((pattern) => pattern.test(normalized));
    if (isMatch) {
      logger.info(`Detected button click pattern: "${normalized}"`);
    }
    return isMatch;
  }

  async handleIncomingMessage(
    phoneNumber: string,
    messageBody: string
  ): Promise<string> {
    try {
      const normalizedMessage = messageBody.trim().toLowerCase();

      // Handle commands
      if (normalizedMessage.startsWith("/")) {
        return await this.handleCommand(phoneNumber, normalizedMessage);
      }

      // Check if this is a new user
      const user = await supabaseService.getUserByPhone(phoneNumber);

      if (!user) {
        // Create new user
        await supabaseService.createUser({
          phone_number: phoneNumber,
          status: "active",
          timezone: undefined,
          location: undefined,
        });
        // Go straight to main menu (no gender question)
        await this.sendMainMenu(phoneNumber, "prefer_not_to_say");
        return ""; // Empty string means template was sent
      }

      // Show main menu (use user's gender if set, otherwise show all options)
      const gender: Gender = (user.gender as Gender) || "prefer_not_to_say";
      await this.sendMainMenu(phoneNumber, gender);
      return ""; // Empty string means template was sent
    } catch (error) {
      logger.error("Error handling incoming message:", error);
      return "Sorry, there was an error processing your message. Please try again.";
    }
  }

  private async handleCommand(
    phoneNumber: string,
    command: string
  ): Promise<string> {
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case "/start":
      case "/menu":
        // Always open the main menu template instead of text menu
        try {
          const user = await supabaseService.getUserByPhone(phoneNumber);
          const gender: Gender =
            (user?.gender as Gender) || "prefer_not_to_say";
          await this.sendMainMenu(phoneNumber, gender);
          return "";
        } catch (error) {
          logger.error("Error handling /start or /menu command:", error);
          return "Sorry, there was an error opening the menu. Please try again.";
        }

      case "/help":
        return await menuCommand.showHelp(phoneNumber);

      case "/templates":
        return await menuCommand.showTemplates(phoneNumber);

      case "/settings":
        const settingsCommand = (await import("./commands/settings")).default;
        return await settingsCommand.getReminderSettings(phoneNumber);

      case "/sunset":
        return await menuCommand.handleReminderTypeCommand(
          phoneNumber,
          "sunset",
          args.join(" ")
        );

      case "/candles":
      case "/candle":
      case "/candlelighting":
        return await menuCommand.handleReminderTypeCommand(
          phoneNumber,
          "candle_lighting",
          args.join(" ")
        );

      case "/prayer":
      case "/prayers":
        return await menuCommand.handleReminderTypeCommand(
          phoneNumber,
          "prayer",
          args.join(" ")
        );

      case "/reminders":
        const remindersCommand = (await import("./commands/reminders")).default;
        const remindersResult = await remindersCommand.listReminders(
          phoneNumber
        );
        // If empty string, template was sent, return a confirmation message
        if (remindersResult === "") {
          return "📋 Sending your reminders list...";
        }
        return remindersResult;

      case "/delete":
        if (args.length === 0) {
          return "Please provide a reminder ID. Use /reminders to see your reminders.";
        }
        const deleteCommand = (await import("./commands/reminders")).default;
        return await deleteCommand.deleteReminder(phoneNumber, args[0]);

      case "/edit":
        if (args.length < 2) {
          return "Please provide a reminder ID and time. Example: /edit <id> 30";
        }
        const editCommand = (await import("./commands/reminders")).default;
        return await editCommand.editReminder(
          phoneNumber,
          args[0],
          args.slice(1).join(" ")
        );

      default:
        return "Unknown command. Use /menu to see available commands.";
    }
  }

  /**
   * Sends main menu template based on user gender
   */
  private async sendMainMenu(
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
      await twilioService.sendTemplateMessage(
        phoneNumber,
        "mainMenu"
        // No variables - Quick Reply templates have static button text
      );

      logger.info(`Main menu template sent to ${phoneNumber}`);
    } catch (error: any) {
      logger.error(`Error sending main menu to ${phoneNumber}:`, error);
      
      // Always send fallback menu for ANY error
      try {
        const user = await supabaseService.getUserByPhone(phoneNumber);
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
        logger.info(`✅ Fallback menu sent to ${phoneNumber}`);
      } catch (fallbackError) {
        logger.error(`❌ Failed to send fallback menu to ${phoneNumber}:`, fallbackError);
        throw fallbackError;
      }
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
      const user = await supabaseService.getUserByPhone(phoneNumber);
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
        `Button identifier: "${buttonIdentifier}", normalized: "${normalizedButton}", clean: "${cleanButton}"`
      );

      // Check if this is a gender selection (from gender question template)
      // Single, clear IDs per option
      const isGenderSelection =
        normalizedButton === "male" ||
        normalizedButton === "female" ||
        normalizedButton === "prefer_not_to_say";

      // Check if this is a main menu selection (reminder type)
      const isMainMenuSelection =
        normalizedButton === "tefillin" ||
        normalizedButton === "candle_lighting" ||
        normalizedButton === "shema";

      // Check if this is an edit button from reminders list (format: "edit_<reminder_id>")
      const isEditReminderButton = normalizedButton.startsWith("edit_");

      // Check if this is a time selection from a time picker template
      // For tefillin: "30", "45", "60" (minutes before)
      // For shema: "10", "20", "60" (minutes before)
      const isTimePickerSelection =
        normalizedButton === "30" ||
        normalizedButton === "45" ||
        normalizedButton === "60" ||
        normalizedButton === "10" ||
        normalizedButton === "20";

      // Check if this is a city selection
      const isCitySelection =
        normalizedButton === "jerusalem" ||
        normalizedButton === "beer sheva" ||
        normalizedButton === "tel aviv" ||
        normalizedButton === "eilat" ||
        normalizedButton === "haifa";

      if (isGenderSelection) {
        // User selected gender - save it and show main menu
        let gender: Gender = "prefer_not_to_say";
        if (normalizedButton === "male") {
          gender = "male";
        } else if (normalizedButton === "female") {
          gender = "female";
        }

        await supabaseService.updateUser(phoneNumber, {
          gender,
          status: "active",
        });

        logger.info(`✅ Gender saved for ${phoneNumber}: ${gender}`);
        await this.sendMainMenu(phoneNumber, gender);
      } else if (isMainMenuSelection) {
        // User selected reminder type from main menu
        // For now, do NOT enforce gender-based restrictions – all users can choose any option
        if (normalizedButton === "tefillin") {
          // For tefillin, first ask for city, then time picker will be based on that city
          this.creatingReminderType.set(phoneNumber, "tefillin");
          await this.sendCityPicker(phoneNumber);
        } else if (normalizedButton === "candle_lighting") {
          // For candle lighting, also ask for city first
          this.creatingReminderType.set(phoneNumber, "candle_lighting");
          await this.sendCityPicker(phoneNumber);
        } else if (normalizedButton === "shema") {
          this.creatingReminderType.set(phoneNumber, "shema");
          await this.sendShemaTimePicker(phoneNumber);
        }
      } else if (isEditReminderButton) {
        // User clicked "Edit" on a reminder → store reminder ID and send time picker template
        const reminderId = normalizedButton.replace("edit_", "");
        logger.info(
          `✅ Detected edit reminder button for reminder ID: ${reminderId}`
        );

        // Store which reminder is being edited
        editingReminders.set(phoneNumber, reminderId);

        // Send time picker template
        await this.sendTimePickerForSunset(
          phoneNumber,
          user.location || "Jerusalem"
        );
      } else if (isTimePickerSelection) {
        // User selected time from time picker
        const editingReminderId = editingReminders.get(phoneNumber);
        const currentReminderType = editingReminderId
          ? (await supabaseService.getReminderSettings(user.id!)).find(
              (s) => s.id === editingReminderId
            )?.reminder_type
          : null;

        if (editingReminderId && currentReminderType) {
          // Editing existing reminder
          logger.info(
            `✅ Editing existing reminder ${editingReminderId} with time selection: ${buttonIdentifier}`
          );
          await this.updateReminderFromTimePicker(
            phoneNumber,
            editingReminderId,
            buttonIdentifier,
            currentReminderType
          );
          editingReminders.delete(phoneNumber);
        } else {
          // Creating new reminder - need to know which type
          // This should be tracked separately, but for now we'll infer from context
          // Store the reminder type being created
          const creatingReminderType =
            this.getCreatingReminderType(phoneNumber);
          if (creatingReminderType) {
            await this.saveReminderFromTimePicker(
              phoneNumber,
              creatingReminderType,
              buttonIdentifier
            );
          }
        }
      } else if (isCitySelection) {
        // User selected a specific city
        const currentReminderType = this.getCreatingReminderType(phoneNumber);

        if (currentReminderType === "candle_lighting") {
          // Candle lighting flow: save reminder + location
          await this.saveCandleLightingReminder(phoneNumber, buttonIdentifier);
        } else if (currentReminderType === "tefillin") {
          // Tefillin flow: save location, then show tefillin time picker
          const city = buttonIdentifier;
          await supabaseService.updateUser(phoneNumber, { location: city });
          logger.info(
            `✅ Saved location "${city}" for tefillin reminder flow for ${phoneNumber}`
          );
          await this.sendTefilinTimePicker(phoneNumber, city);
        } else {
          // Fallback: just update location for user, no specific reminder type
          const city = buttonIdentifier;
          await supabaseService.updateUser(phoneNumber, { location: city });
          logger.info(
            `⚠️ City "${city}" selected without active reminder type for ${phoneNumber} - location updated only`
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
      logger.info(
        `🌅 Preparing to send time picker template to ${phoneNumber} for location: ${location}`
      );

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
          logger.info(
            `Trying inferred location "${inferredLocation}" as fallback`
          );
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

      try {
        // Try sending the time picker template with variables
        await twilioService.sendTemplateMessage(
          phoneNumber,
          "timePicker", // This will use config.templates.timePicker
          templateVariables
        );

        logger.info(
          `Time picker template sent to ${phoneNumber} for sunset time: ${sunsetData.sunset}`
        );
      } catch (templateError: any) {
        // If template with variables fails, try without variables
        if (templateError.code === 21656) {
          logger.warn(
            `Template variables error (21656) - trying without variables or sending formatted message`
          );

          try {
            // Try sending template without variables
            await twilioService.sendTemplateMessage(phoneNumber, "timePicker");
            logger.info(
              `Time picker template sent without variables to ${phoneNumber}`
            );
          } catch (noVarError) {
            // Fallback: Send formatted plain text message
            const formattedMessage =
              `🌅 Sunset Time Information\n\n` +
              `📍 Location: ${location}\n` +
              `📅 Date: ${sunsetData.date}\n` +
              `⏰ Sunset: ${sunsetData.sunset}\n` +
              (sunsetData.candle_lighting
                ? `🕯️ Candle Lighting: ${sunsetData.candle_lighting}\n`
                : "");

            await twilioService.sendMessage(phoneNumber, formattedMessage);
            logger.info(`Sent formatted message as fallback to ${phoneNumber}`);
          }
        } else {
          throw templateError;
        }
      }
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

  /**
   * Sends time picker for tefillin reminder
   * If locationOverride is provided (from city picker), use it; otherwise use user.location / inferred city.
   */
  private async sendTefilinTimePicker(
    phoneNumber: string,
    locationOverride?: string
  ): Promise<void> {
    try {
      logger.info(`📿 Sending tefillin time picker to ${phoneNumber}`);
      this.creatingReminderType.set(phoneNumber, "tefillin");

      // Determine base location: prefer explicit override, then saved user.location, then inferred city
      const user = await supabaseService.getUserByPhone(phoneNumber);
      const baseLocation =
        locationOverride ||
        (user && user.location) ||
        this.inferLocationFromPhoneNumber(phoneNumber);

      // Get sunset time for that location from Hebcal
      const sunsetData = await hebcalService.getSunsetData(baseLocation);
      const sunsetTime = sunsetData?.sunset || "18:00";

      // For tefilintimepicker_v3 we only need one variable: {{1}} = sunsetTime
      const templateVariables: Record<string, string> = {
        "1": sunsetTime,
      };

      await twilioService.sendTemplateMessage(
        phoneNumber,
        "tefillinTimePicker",
        templateVariables
      );
      logger.info(
        `Tefilin time picker (V2) sent to ${phoneNumber} with sunset ${sunsetTime} for location ${baseLocation}`
      );
    } catch (error) {
      logger.error(
        `Error sending tefillin time picker to ${phoneNumber}:`,
        error
      );
      // Fallback
      await twilioService.sendMessage(
        phoneNumber,
        "כמה זמן לפני השקיעה?\n\n1. 30 דקות\n2. 45 דקות\n3. 1 שעה"
      );
    }
  }

  /**
   * Sends city picker for candle lighting reminder
   */
  private async sendCityPicker(phoneNumber: string): Promise<void> {
    try {
      logger.info(`🕯️ Sending city picker to ${phoneNumber}`);
      // Get list of cities from Hebcal (common cities)
      // For now, using a predefined list - can be enhanced to fetch from API
      const cities = [
        { name: "ירושלים", id: "Jerusalem", desc: "ירושלים" },
        { name: "באר שבע", id: "Beer Sheva", desc: "באר שבע" },
        { name: "תל אביב", id: "Tel Aviv", desc: "תל אביב" },
        { name: "אילת", id: "Eilat", desc: "אילת" },
        { name: "חיפה", id: "Haifa", desc: "חיפה" },
      ];

      const templateVariables: Record<string, string> = {};
      cities.forEach((city, index) => {
        const baseVar = index * 3 + 1;
        templateVariables[String(baseVar)] = city.name;
        templateVariables[String(baseVar + 1)] = city.id;
        templateVariables[String(baseVar + 2)] = city.desc;
      });

      await twilioService.sendTemplateMessage(
        phoneNumber,
        "cityPicker",
        templateVariables
      );
      logger.info(`City picker sent to ${phoneNumber}`);
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
   * Sends time picker for shema reminder
   */
  private async sendShemaTimePicker(phoneNumber: string): Promise<void> {
    try {
      logger.info(`📖 Sending shema time picker to ${phoneNumber}`);
      this.creatingReminderType.set(phoneNumber, "shema");

      // Determine base location: use user's saved location if available, otherwise infer from phone
      const user = await supabaseService.getUserByPhone(phoneNumber);
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
      logger.info(`Shema time picker sent to ${phoneNumber}`);
    } catch (error) {
      logger.error(`Error sending shema time picker to ${phoneNumber}:`, error);
      // Fallback
      await twilioService.sendMessage(
        phoneNumber,
        "כמה זמן לפני?\n\n1. 10 דקות\n2. 20 דקות\n3. 1 שעה לפני"
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
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
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

      await supabaseService.upsertReminderSetting({
        user_id: user.id,
        reminder_type: reminderType,
        enabled: true,
        time_offset_minutes: timeOffsetMinutes,
      });

      this.creatingReminderType.delete(phoneNumber);

      // Send confirmation
      const typeNames: Record<ReminderType, string> = {
        tefillin: "הנחת תפילין",
        candle_lighting: "הדלקת נרות",
        shema: "זמן קריאת שמע",
      };

      const timeDescriptions: Record<string, string> = {
        "10": "10 דקות לפני",
        "20": "20 דקות לפני",
        "30": "30 דקות לפני",
        "45": "45 דקות לפני",
        "60": "שעה לפני",
      };

      await twilioService.sendMessage(
        phoneNumber,
        `✅ התזכורת הוגדרה בהצלחה!\n\n📌 סוג: ${
          typeNames[reminderType]
        }\n⏰ זמן: ${timeDescriptions[timeId] || timeId}`
      );

      logger.info(
        `✅ Reminder saved: ${reminderType} with offset ${timeOffsetMinutes} minutes for ${phoneNumber}`
      );
    } catch (error) {
      logger.error(`Error saving reminder for ${phoneNumber}:`, error);
      await twilioService.sendMessage(
        phoneNumber,
        "❌ שגיאה בשמירת התזכורת. נסה שוב."
      );
    }
  }

  /**
   * Saves candle lighting reminder with location
   */
  private async saveCandleLightingReminder(
    phoneNumber: string,
    city: string | null
  ): Promise<void> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
        throw new Error("User not found");
      }

      // Update user location if city was provided
      if (city) {
        await supabaseService.updateUser(phoneNumber, { location: city });
      }

      // Save reminder (no time offset for candle lighting - sent at 8:00 AM on Friday)
      await supabaseService.upsertReminderSetting({
        user_id: user.id,
        reminder_type: "candle_lighting",
        enabled: true,
        time_offset_minutes: 0, // Special handling in scheduler
      });

      this.creatingReminderType.delete(phoneNumber);

      await twilioService.sendMessage(
        phoneNumber,
        `✅ התזכורת הוגדרה בהצלחה!\n\n📌 סוג: הדלקת נרות שבת\n📍 עיר: ${city}\n\nתזכורת תשלח כל יום שישי ב-8:00 בבוקר.`
      );

      logger.info(
        `✅ Candle lighting reminder saved for ${phoneNumber} with city: ${city}`
      );
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
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || !user.id) {
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

      await supabaseService.upsertReminderSetting({
        user_id: user.id,
        reminder_type: reminderType,
        enabled: true,
        time_offset_minutes: timeOffsetMinutes,
      });

      const typeNames: Record<ReminderType, string> = {
        tefillin: "הנחת תפילין",
        candle_lighting: "הדלקת נרות",
        shema: "זמן קריאת שמע",
      };

      await twilioService.sendMessage(
        phoneNumber,
        `✅ התזכורת עודכנה בהצלחה!\n\n📌 סוג: ${typeNames[reminderType]}`
      );

      logger.info(`✅ Reminder ${reminderId} updated for ${phoneNumber}`);
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
}

export default new MessageHandler();
