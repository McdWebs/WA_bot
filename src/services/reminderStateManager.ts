import logger from "../utils/logger";

/**
 * User state modes for reminder management flow
 */
export enum ReminderStateMode {
  CHOOSE_REMINDER = "CHOOSE_REMINDER", // User is selecting a reminder by number
  REMINDER_ACTION = "REMINDER_ACTION", // User selected reminder, choosing edit/delete
  EDIT_REMINDER = "EDIT_REMINDER", // User is editing a reminder (waiting for time picker selection)
  CONFIRMING_DELETE = "CONFIRMING_DELETE", // User is confirming deletion
}

/**
 * State data structure
 */
export interface ReminderState {
  mode: ReminderStateMode;
  reminderId?: string; // Current reminder being edited/deleted
  reminders?: Array<{ index: number; reminderId: string }>; // List mapping for CHOOSE_REMINDER mode
}

/**
 * In-memory state manager for reminder management flows
 * Maps phoneNumber -> ReminderState
 */
class ReminderStateManager {
  private state = new Map<string, ReminderState>();

  /**
   * Sets user state
   */
  setState(phoneNumber: string, state: ReminderState): void {
    this.state.set(phoneNumber, state);
    logger.info(`State set for ${phoneNumber}: ${state.mode}`, {
      reminderId: state.reminderId,
    });
  }

  /**
   * Gets user state
   */
  getState(phoneNumber: string): ReminderState | null {
    return this.state.get(phoneNumber) || null;
  }

  /**
   * Clears user state
   */
  clearState(phoneNumber: string): void {
    this.state.delete(phoneNumber);
    logger.info(`State cleared for ${phoneNumber}`);
  }

  /**
   * Checks if user is in a specific mode
   */
  isInMode(phoneNumber: string, mode: ReminderStateMode): boolean {
    const state = this.getState(phoneNumber);
    return state?.mode === mode;
  }

  /**
   * Gets reminder ID from state (for REMINDER_ACTION or EDIT_REMINDER modes)
   */
  getReminderId(phoneNumber: string): string | null {
    const state = this.getState(phoneNumber);
    return state?.reminderId || null;
  }

  /**
   * Gets reminder ID by list index (for CHOOSE_REMINDER mode)
   */
  getReminderIdByIndex(phoneNumber: string, index: number): string | null {
    const state = this.getState(phoneNumber);
    if (state?.mode !== ReminderStateMode.CHOOSE_REMINDER || !state.reminders) {
      return null;
    }
    const reminder = state.reminders.find((r) => r.index === index);
    return reminder?.reminderId || null;
  }
}

export default new ReminderStateManager();
