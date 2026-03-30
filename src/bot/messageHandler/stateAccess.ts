import type { ReminderType } from "../../types";
import type { MessageHandlerMutableState } from "./state";

export function getCreatingReminderType(
  state: MessageHandlerMutableState,
  phoneNumber: string
): ReminderType | null {
  return state.creatingReminderType.get(phoneNumber) || null;
}
