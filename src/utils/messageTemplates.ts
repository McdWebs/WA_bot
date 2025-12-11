import { MessageTemplate, ReminderType } from '../types';

export const messageTemplates: MessageTemplate[] = [
  {
    id: 'sunset_default',
    name: 'Sunset Reminder',
    reminder_type: 'sunset',
    content: '🌅 Reminder: Sunset is at {time} today. Have a blessed evening!',
  },
  {
    id: 'candle_lighting_default',
    name: 'Candle Lighting Reminder',
    reminder_type: 'candle_lighting',
    content: '🕯️ Reminder: Candle lighting time is at {time} today. Shabbat Shalom!',
  },
  {
    id: 'prayer_default',
    name: 'Prayer Time Reminder',
    reminder_type: 'prayer',
    content: '🙏 Reminder: {prayer_name} prayer time is at {time} today.',
  },
];

export class MessageTemplateService {
  getTemplate(reminderType: ReminderType): MessageTemplate | null {
    return messageTemplates.find((t) => t.reminder_type === reminderType) || null;
  }

  formatTemplate(template: MessageTemplate, data: Record<string, string>): string {
    let message = template.content;
    
    // Replace placeholders
    for (const [key, value] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
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

