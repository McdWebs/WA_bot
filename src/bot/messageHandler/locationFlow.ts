import mongoService from "../../services/mongo";
import twilioService from "../../services/twilio";
import logger from "../../utils/logger";
import type { ReminderType } from "../../types";
import {
  sendCandleLightingTimePicker,
  sendShemaTimePicker,
  sendTaaraTimePicker,
  sendTefilinTimePicker,
} from "./pickers";
import type { MessageHandlerMutableState } from "./state";

/**
 * Saves location and continues the reminder flow, or only confirms for settings.
 * Returns false if the city string is invalid (caller may keep awaiting custom input).
 */
export async function completeLocationSelection(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  city: string,
  flowContext: ReminderType | "settings"
): Promise<boolean> {
  const trimmed = city.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 80) {
    await twilioService.sendMessage(
      phoneNumber,
      "נא לשלוח שם מקום תקין (בין 2 ל־80 תווים)."
    );
    return false;
  }

  await mongoService.updateUser(phoneNumber, { location: trimmed });
  state.lastCityPickerContext.delete(phoneNumber);

  if (flowContext === "settings") {
    state.creatingReminderType.delete(phoneNumber);
    await twilioService.sendMessage(
      phoneNumber,
      `✅ המיקום עודכן ל: ${trimmed}`
    );
    return true;
  }

  logger.info(
    `✅ Saved location "${trimmed}" for reminder flow (${flowContext}) for ${phoneNumber}`
  );

  if (flowContext === "candle_lighting") {
    await sendCandleLightingTimePicker(phoneNumber);
  } else if (flowContext === "tefillin") {
    await sendTefilinTimePicker(state, phoneNumber, trimmed);
  } else if (flowContext === "shema") {
    await sendShemaTimePicker(state, phoneNumber);
  } else if (flowContext === "taara") {
    logger.info(
      `👩‍🧕 City "${trimmed}" selected for tahara flow for ${phoneNumber} – sending taara time picker`
    );
    await sendTaaraTimePicker(phoneNumber);
  } else {
    logger.info(
      `⚠️ Location "${trimmed}" saved but no handler for reminder type "${flowContext}" for ${phoneNumber}`
    );
    state.creatingReminderType.delete(phoneNumber);
  }
  return true;
}

export async function continueReminderFlowWithSavedLocation(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  reminderType: ReminderType
): Promise<boolean> {
  const user = await mongoService.getUserByPhone(phoneNumber);
  const savedLocation = user?.location?.trim();

  if (!savedLocation) {
    return false;
  }

  state.lastCityPickerContext.delete(phoneNumber);
  state.awaitingCustomLocation.delete(phoneNumber);

  state.creatingReminderType.set(phoneNumber, reminderType);
  logger.info(
    `📍 Using saved location "${savedLocation}" for ${phoneNumber}, skipping city picker for ${reminderType}`
  );

  if (reminderType === "tefillin") {
    await sendTefilinTimePicker(state, phoneNumber, savedLocation);
  } else if (reminderType === "shema") {
    await sendShemaTimePicker(state, phoneNumber);
  } else if (reminderType === "candle_lighting") {
    await sendCandleLightingTimePicker(phoneNumber);
  } else if (reminderType === "taara") {
    await sendTaaraTimePicker(phoneNumber);
  }

  return true;
}
