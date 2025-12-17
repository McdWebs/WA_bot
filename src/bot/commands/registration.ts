import supabaseService from "../../services/supabase";
import twilioService from "../../services/twilio";
import timezoneService from "../../utils/timezone";
import logger from "../../utils/logger";
import { User } from "../../types";

export class RegistrationCommand {
  async handleNewUser(
    phoneNumber: string,
    messageBody: string
  ): Promise<string> {
    try {
      // Check if user already exists
      const existingUser = await supabaseService.getUserByPhone(phoneNumber);

      if (existingUser) {
        if (existingUser.status === "pending") {
          // User is in registration process
          return this.handleRegistrationStep(existingUser, messageBody);
        } else {
          // User is already registered
          return "You are already registered! Use /menu to see available options.";
        }
      }

      // Create new user with pending status
      const newUser: Omit<User, "id" | "created_at" | "updated_at"> = {
        phone_number: phoneNumber,
        status: "pending",
        timezone: undefined,
        location: undefined,
      };

      await supabaseService.createUser(newUser);

      return 'Welcome to the Reminders Bot! 🌟\n\nTo get started, please tell me your location (city name, e.g., "Jerusalem" or "New York"). This helps us set your timezone correctly.';
    } catch (error) {
      logger.error("Error handling new user:", error);
      return "Sorry, there was an error processing your registration. Please try again later.";
    }
  }

  private async handleRegistrationStep(
    user: User,
    messageBody: string
  ): Promise<string> {
    // If user doesn't have location, this is the location step
    if (!user.location) {
      const location = messageBody.trim();

      if (location.length < 2) {
        return 'Please provide a valid location (city name). For example: "Jerusalem" or "New York".';
      }

      // Detect timezone from location
      const timezone = await timezoneService.detectTimezoneFromLocation(
        location
      );

      // Update user with location and timezone
      await supabaseService.updateUser(user.phone_number, {
        location,
        timezone,
        status: "active",
      });

      return `Great! I've set your location to ${location} and timezone to ${timezone}.\n\nYou're all set! Use /menu to see available reminder options.`;
    }

    return "Registration complete! Use /menu to see available options.";
  }

  async isRegistrationInProgress(phoneNumber: string): Promise<boolean> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      return user?.status === "pending" || false;
    } catch (error) {
      logger.error("Error checking registration status:", error);
      return false;
    }
  }
}

export default new RegistrationCommand();
