import twilioService from "../../services/twilio";
import { completeLocationSelection } from "./locationFlow";
import { getCreatingReminderType } from "./stateAccess";
import type { MessageHandlerMutableState } from "./state";
import type { ReminderType } from "../../types";

/**
 * WhatsApp shared location (Latitude/Longitude on webhook). Only during custom-location flow.
 * Stores `geo:lat,lng` in user.location; zmanim use coordinates via hebcalService.
 */
export async function incomingLocationFlow(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  latitude: number,
  longitude: number
): Promise<boolean> {
  if (!state.awaitingCustomLocation.has(phoneNumber)) {
    return false;
  }

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    await twilioService.sendMessage(
      phoneNumber,
      "לא הצלחתי לקרוא את המיקום. נסו לשלוח שוב דרך 📎 ← מיקום."
    );
    return true;
  }

  const flowContext: ReminderType | "settings" =
    state.lastCityPickerContext.get(phoneNumber) ??
    getCreatingReminderType(state, phoneNumber) ??
    "settings";
  const geoStr = `geo:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const ok = await completeLocationSelection(
    state,
    phoneNumber,
    geoStr,
    flowContext
  );
  if (ok) {
    state.awaitingCustomLocation.delete(phoneNumber);
  }
  return true;
}
