import { MessageTemplate, ReminderType } from "../types";

export const messageTemplates: MessageTemplate[] = [
  {
    id: "tefillin_default",
    name: "Tefilin Reminder",
    reminder_type: "tefillin",
    content: "📿 תזכורת: הנחת תפילין ב-{time} היום.",
  },
  {
    id: "candle_lighting_default",
    name: "Candle Lighting Reminder",
    reminder_type: "candle_lighting",
    content: "🕯️ תזכורת: הדלקת נרות שבת ב-{time} היום. שבת שלום!",
  },
  {
    id: "shema_default",
    name: "Shema Time Reminder",
    reminder_type: "shema",
    content: "📖 תזכורת: זמן קריאת שמע ב-{time} היום.",
  },
];

export class MessageTemplateService {
  getTemplate(reminderType: ReminderType): MessageTemplate | null {
    return (
      messageTemplates.find((t) => t.reminder_type === reminderType) || null
    );
  }

  formatTemplate(
    template: MessageTemplate,
    data: Record<string, string>
  ): string {
    let message = template.content;

    // Replace placeholders
    for (const [key, value] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }

    return message;
  }

  formatReminderMessage(
    reminderType: ReminderType,
    time: string,
    additionalData?: Record<string, string>
  ): string {
    const template = this.getTemplate(reminderType);
    if (!template) {
      // Fallback message
      return `Reminder: ${reminderType} is at ${time} today.`;
    }

    return this.formatTemplate(template, {
      time,
      ...additionalData,
    });
  }

  getAllTemplates(): MessageTemplate[] {
    return messageTemplates;
  }

  getTemplatesByType(reminderType: ReminderType): MessageTemplate[] {
    return messageTemplates.filter((t) => t.reminder_type === reminderType);
  }
}

export default new MessageTemplateService();
