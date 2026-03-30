import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import reminderService from "../../services/reminderService";
import reminderStateManager, { ReminderStateMode } from "../../services/reminderStateManager";

/**
 * Handles delete confirmation
 */
export async function handleDeleteConfirmation(
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
      // Send loading message for better UX
      await twilioService.sendMessage(phoneNumber, "⏳ מוחק את התזכורת...");
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
