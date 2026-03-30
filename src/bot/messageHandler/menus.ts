import mongoService from "../../services/mongo";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import type { Gender } from "../../types";

/**
 * Sends main menu template based on user gender
 */
export async function sendMainMenu(
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
    const templateKey =
      gender === "female"
        ? "womanMenu"
        : "mainMenu";

    await twilioService.sendTemplateMessage(
      phoneNumber,
      templateKey
      // No variables - Quick Reply templates have static button text
    );

    logger.debug(`Main menu template sent to ${phoneNumber}`);
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
      logger.debug(`Fallback menu sent to ${phoneNumber}`);
    } catch (fallbackError) {
      logger.error(`❌ Failed to send fallback menu to ${phoneNumber}:`, fallbackError);
      throw fallbackError;
    }
  }
}

/**
 * Sends the "manage reminders" quick-reply menu
 */
export async function sendManageRemindersMenu(phoneNumber: string): Promise<void> {
  try {
    logger.debug(`Sending manage reminders menu (free-form text) to ${phoneNumber}`);
    await twilioService.sendMessage(
      phoneNumber,
      "מה תרצה לעשות?\n\n➕ *תזכורת חדשה* - להוספת תזכורת\n📋 *הצג תזכורות* - לצפייה וניהול התזכורות\n🔙 *חזרה* - לחזרה לתפריט הראשי"
    );
    logger.debug(`Manage reminders text menu sent to ${phoneNumber}`);
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
