import logger from "../utils/logger";

export enum SettingsStateMode {
  MAIN_MENU = "MAIN_MENU", // User is in settings root (1=gender, 2=reminders, 3=location)
  CHANGE_GENDER = "CHANGE_GENDER", // Waiting for gender selection (1=male, 2=female)
}

export interface SettingsState {
  mode: SettingsStateMode;
}

class SettingsStateManager {
  private state = new Map<string, SettingsState>();

  setState(phoneNumber: string, state: SettingsState): void {
    this.state.set(phoneNumber, state);
    logger.info(`Settings state set for ${phoneNumber}: ${state.mode}`);
  }

  getState(phoneNumber: string): SettingsState | null {
    return this.state.get(phoneNumber) || null;
  }

  clearState(phoneNumber: string): void {
    this.state.delete(phoneNumber);
    logger.info(`Settings state cleared for ${phoneNumber}`);
  }

  isInMode(phoneNumber: string, mode: SettingsStateMode): boolean {
    const state = this.getState(phoneNumber);
    return state?.mode === mode;
  }
}

export default new SettingsStateManager();

