import { isButtonClick as isButtonClickUtil } from "./messageHandler/pure/isButtonClick";
import { incomingMessageFlow } from "./messageHandler/incomingMessageFlow";
import { interactiveButtonFlow } from "./messageHandler/interactiveButtonFlow";
import { incomingLocationFlow } from "./messageHandler/incomingLocationFlow";
import { sendMainMenu } from "./messageHandler/menus";
import { createMessageHandlerState } from "./messageHandler/state";
import type { Gender } from "../types";

export class MessageHandler {
  private readonly state = createMessageHandlerState();

  /**
   * Checks if a message body represents a button click from an interactive template
   */
  isButtonClick(messageBody: string): boolean {
    return isButtonClickUtil(messageBody);
  }

  async handleIncomingMessage(
    phoneNumber: string,
    messageBody: string
  ): Promise<string> {
    return incomingMessageFlow(this.state, phoneNumber, messageBody);
  }

  /**
   * Sends main menu template based on user gender
   */
  async sendMainMenu(phoneNumber: string, gender: Gender): Promise<void> {
    return sendMainMenu(phoneNumber, gender);
  }

  async handleInteractiveButton(
    phoneNumber: string,
    buttonIdentifier: string
  ): Promise<void> {
    return interactiveButtonFlow(this.state, phoneNumber, buttonIdentifier);
  }

  /**
   * WhatsApp shared location (Latitude/Longitude on webhook). Only during custom-location flow.
   */
  async handleIncomingLocation(
    phoneNumber: string,
    latitude: number,
    longitude: number
  ): Promise<boolean> {
    return incomingLocationFlow(this.state, phoneNumber, latitude, longitude);
  }
}

export default new MessageHandler();
