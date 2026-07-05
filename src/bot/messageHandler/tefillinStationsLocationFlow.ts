import twilioService from "../../services/twilio";
import mongoService from "../../services/mongo";
import logger from "../../utils/logger";
import {
  findNearestStations,
  formatStationsMessage,
} from "../../services/tefillinStationsService";
import { sendMainMenu } from "./menus";
import type { MessageHandlerMutableState } from "./state";
import type { Gender } from "../../types";

/**
 * WhatsApp shared location during the "📍 עמדות תפילין" flow. Looks up the
 * nearest tefillin stations and replies with the list. Lookup-only: does NOT
 * persist user.location (unlike the reminder custom-location flow).
 *
 * Returns true if the location belonged to this flow (so the caller stops),
 * false if the user wasn't awaiting a stations lookup.
 */
export async function tefillinStationsLocationFlow(
  state: MessageHandlerMutableState,
  phoneNumber: string,
  latitude: number,
  longitude: number
): Promise<boolean> {
  if (!state.awaitingTefillinStationsLocation.has(phoneNumber)) {
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

  // Consume the state now so a failure doesn't leave the user stuck waiting.
  state.awaitingTefillinStationsLocation.delete(phoneNumber);

  try {
    const total = await mongoService.countTefillinStations();
    if (total === 0) {
      logger.error(
        "Tefillin stations lookup requested but collection is empty — run `npm run import:tefillin-stations`"
      );
      await twilioService.sendMessage(
        phoneNumber,
        "מאגר עמדות התפילין עדיין לא נטען. נסו שוב מאוחר יותר. 🙏"
      );
      return true;
    }

    const stations = await findNearestStations(latitude, longitude, 8);
    await twilioService.sendMessage(phoneNumber, formatStationsMessage(stations));

    // Offer a way back to the main menu.
    const user = await mongoService.getUserByPhone(phoneNumber);
    const gender: Gender = (user?.gender as Gender) || "prefer_not_to_say";
    await sendMainMenu(phoneNumber, gender);
  } catch (error) {
    logger.error(
      `Error finding tefillin stations for ${phoneNumber}:`,
      error
    );
    await twilioService.sendMessage(
      phoneNumber,
      "אירעה שגיאה באיתור עמדות התפילין. נסו שוב מאוחר יותר."
    );
  }

  return true;
}
