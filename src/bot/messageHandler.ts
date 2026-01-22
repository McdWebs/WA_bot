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

      // Check user state for reminder management flow
      const state = reminderStateManager.getState(phoneNumber);
      
      if (state?.mode === ReminderStateMode.CHOOSE_REMINDER) {
        // User is selecting a reminder by number (1, 2, 3...)
        const result = await reminderService.selectReminder(phoneNumber, messageBody);
        if (result) {
          await twilioService.sendMessage(phoneNumber, result);
        }
        return "";
      } else if (state?.mode === ReminderStateMode.REMINDER_ACTION) {
        // User selected a reminder and now choosing action (edit/delete/back)
        const normalized = normalizedMessage;
        let action: "edit" | "delete" | "back" | null = null;
        
        if (normalized.includes("ערוך") || normalized.includes("edit")) {
          action = "edit";
        } else if (normalized.includes("מחק") || normalized.includes("delete")) {
          action = "delete";
        } else if (normalized.includes("חזרה") || normalized.includes("back")) {
          action = "back";
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
          return "";
        } else {
          return "אנא בחר/י פעולה:\n✏️ *ערוך* - לעריכת התזכורת\n🗑️ *מחק* - למחיקת התזכורת\n🔙 *חזרה* - חזרה לרשימה";
        }
      } else if (state?.mode === ReminderStateMode.CONFIRMING_DELETE) {
        // User is confirming deletion
        return await this.handleDeleteConfirmation(phoneNumber, messageBody);
      }

      // Check if this is a new user
      const user = await mongoService.getUserByPhone(phoneNumber);

      if (!user) {
        // Create new user
        await mongoService.createUser({
          phone_number: phoneNumber,
          status: "active",
          timezone: undefined,
          location: undefined,
        });
        // First interaction: go straight to manage reminders menu
        await this.sendManageRemindersMenu(phoneNumber);
        return ""; // Template sent
      }

      // Check for text-based actions
      if (normalizedMessage.includes("תזכורת חדשה") || normalizedMessage.includes("חדשה")) {
        const gender: Gender = (user.gender as Gender) || "prefer_not_to_say";
        await this.sendMainMenu(phoneNumber, gender);
        return "";
      } else if (normalizedMessage.includes("חזרה") || normalizedMessage.includes("back")) {
        await this.sendManageRemindersMenu(phoneNumber);
        return "";
      }

      // Default: show manage reminders menu
      await this.sendManageRemindersMenu(phoneNumber);
      return ""; // Template sent
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
      await this.sendManageRemindersMenu(phoneNumber);
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
        logger.info(`✅ Fallback menu sent to ${phoneNumber}`);
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
      logger.info(`🧩 Sending manage reminders menu to ${phoneNumber}`);
      await twilioService.sendTemplateMessage(phoneNumber, "manageReminders");
      logger.info(`Manage reminders menu sent to ${phoneNumber}`);
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

      // Check if this is from the "manage reminders" menu or button
      const isManageRemindersAction =
        normalizedButton === "manage_reminders" ||
        normalizedButton === "show_reminders" ||
        normalizedButton === "add_reminder" ||
        normalizedButton === "close_menu";

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

        await mongoService.updateUser(phoneNumber, {
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
      } else if (isManageRemindersAction) {
        // Handle buttons from manage reminders quick-reply template
        if (normalizedButton === "manage_reminders") {
          // Main menu button to open the manage reminders menu
          await this.sendManageRemindersMenu(phoneNumber);
        } else if (normalizedButton === "show_reminders") {
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
            "תפריט ניהול התזכורות נסגר. אפשר תמיד לפתוח מחדש דרך /menu."
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
          await mongoService.updateUser(phoneNumber, { location: city });
          logger.info(
            `✅ Saved location "${city}" for tefillin reminder flow for ${phoneNumber}`
          );
          await this.sendTefilinTimePicker(phoneNumber, city);
        } else {
          // Fallback: just update location for user, no specific reminder type
          const city = buttonIdentifier;
          await mongoService.updateUser(phoneNumber, { location: city });
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
      const user = await mongoService.getUserByPhone(phoneNumber);
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
      // Ensure user exists – create if missing (e.g. user came in via templates only)
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

      // Save reminder (no time offset for candle lighting - sent at 8:00 AM on Friday)
      await mongoService.upsertReminderSetting({
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
