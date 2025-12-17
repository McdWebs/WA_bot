import supabaseService from "../../services/supabase";
import settingsCommand from "./settings";
import messageTemplateService from "../../utils/messageTemplates";
import logger from "../../utils/logger";

export class MenuCommand {
  async showMenu(phoneNumber: string): Promise<string> {
    try {
      const user = await supabaseService.getUserByPhone(phoneNumber);
      if (!user || user.status !== "active") {
        return "Please complete registration first. Send any message to get started.";
      }

      return (
        `📱 *Reminders Bot Menu*\n\n` +
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
        `• /edit <id> 45 (edit reminder to 45 min before)`
      );
    } catch (error) {
      logger.error("Error showing menu:", error);
      return "Sorry, there was an error displaying the menu.";
    }
  }

  async showHelp(phoneNumber: string): Promise<string> {
    return (
      `❓ *Help & Guidance*\n\n` +
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
      `Use /menu to see all available commands.`
    );
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
      logger.error("Error showing templates:", error);
      return "Sorry, there was an error displaying templates.";
    }
  }

  async handleReminderTypeCommand(
    phoneNumber: string,
    reminderType: string,
    timeInput?: string
  ): Promise<string> {
    // Legacy text commands (/sunset, /candles, /prayer) are no longer used.
    // We now use WhatsApp interactive templates (buttons) for all flows.
    return "This command is no longer used. Just send any message and use the menu buttons to set your reminders.";
  }
}

export default new MenuCommand();
