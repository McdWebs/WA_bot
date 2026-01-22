// Database layer: use MongoDB instead of Supabase
import mongoService from "../../services/mongo";
import settingsCommand from "./settings";
import messageTemplateService from "../../utils/messageTemplates";
import logger from "../../utils/logger";

export class MenuCommand {
  async showMenu(phoneNumber: string): Promise<string> {
    try {
      const user = await mongoService.getUserByPhone(phoneNumber);
      if (!user || user.status !== "active") {
        return "Please complete registration first. Send any message to get started.";
      }

      return (
        `📱 *Reminders Bot Menu*\n\n` +
        `הבוט עובד עם תפריטים וכפתורים בלבד.\n` +
        `פשוט שלח/י הודעה וקבל/י תפריט שבו אפשר:\n\n` +
        `• להגדיר תזכורות חדשות (תפילין / הדלקת נרות / זמן קריאת שמע)\n` +
        `• לבחור עיר ותזמון לפני הזמן\n` +
        `• לראות ולנהל את כל התזכורות דרך תפריט *ניהול התזכורות*`
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
      `1. שלח/י כל הודעה כדי לפתוח תפריט\n` +
      `2. השתמש/י בכפתורים כדי לבחור סוג תזכורת\n` +
      `3. בחרי/בחר עיר וזמן לפני הזמן (דרך כפתורי הבחירה)\n` +
      `4. לנהל תזכורות קיימות דרך תפריט *ניהול התזכורות*\n\n` +
      `הכול נעשה דרך כפתורים – אין צורך בפקודות טקסט.`
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
