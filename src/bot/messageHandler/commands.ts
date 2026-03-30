import twilioService from "../../services/twilio";

export async function handleCommand(
  phoneNumber: string,
  command: string
): Promise<string> {
  const normalized = command.trim().toLowerCase();

  // Minimal command handling – gently push users to use buttons/templates
  if (normalized === "/start" || normalized === "/menu") {
    await twilioService.sendTemplateMessage(phoneNumber, "welcome");
    return "";
  }

  if (normalized === "/help") {
    return "אין צורך בפקודות טקסט 🙂 פשוט השתמש/י בכפתורים שבתפריטים כדי לנהל את התזכורות.";
  }

  return "המערכת עובדת עם כפתורים בלבד. שלח/י הודעה רגילה וקבל/י תפריט עם אפשרויות.";
}
