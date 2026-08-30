import { TelegramClient } from './client.js';
import { formatSignalEvent } from './formatter.js';
import type { SignalEvent, TelegramMessage } from './types.js';

export interface NotificationStore {
  find(eventId: string): Promise<{ delivered: boolean; messageId?: number } | null>;
  markDelivered(eventId: string, message: TelegramMessage): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
}

export class TelegramAlerting {
  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: string,
    private readonly store: NotificationStore,
  ) {}

  async send(event: SignalEvent): Promise<TelegramMessage | null> {
    const existing = await this.store.find(event.eventId);
    if (existing?.delivered) return null;

    try {
      const message = await this.client.sendMessage(this.chatId, formatSignalEvent(event));
      await this.store.markDelivered(event.eventId, message);
      return message;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Telegram delivery error';
      await this.store.markFailed(event.eventId, reason);
      throw error;
    }
  }
}
