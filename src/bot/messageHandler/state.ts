import type { ReminderType } from "../../types";

export const ISRAEL_TZ = "Asia/Jerusalem";

export type FemaleFlowMode = "taara" | "taara_plus_clean7";

/** Mutable per-session maps owned by MessageHandler (same references for bot lifetime). */
export interface MessageHandlerMutableState {
  creatingReminderType: Map<string, ReminderType>;
  lastCityPickerContext: Map<string, ReminderType | "settings">;
  awaitingCustomLocation: Set<string>;
  /** Phones that tapped "📍 עמדות תפילין" and should have their next location pin treated as a stations lookup (not a reminder location). */
  awaitingTefillinStationsLocation: Set<string>;
  femaleFlowMode: Map<string, FemaleFlowMode>;
}

export function createMessageHandlerState(): MessageHandlerMutableState {
  return {
    creatingReminderType: new Map(),
    lastCityPickerContext: new Map(),
    awaitingCustomLocation: new Set(),
    awaitingTefillinStationsLocation: new Set(),
    femaleFlowMode: new Map(),
  };
}
