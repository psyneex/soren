import type { SupabaseClient } from '@supabase/supabase-js';
import type { NotificationStore } from './alerting.js';
import type { TelegramMessage } from './types.js';

export class SupabaseNotificationStore implements NotificationStore {
  constructor(private readonly client: SupabaseClient, private readonly chatId: string) {}

  async find(eventId: string): Promise<{ delivered: boolean; messageId?: number } | null> {
    const { data, error } = await this.client.from('telegram_notifications')
      .select('status, telegram_message_id').eq('event_id', eventId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { delivered: data.status === 'DELIVERED', messageId: data.telegram_message_id ?? undefined };
  }

  async markDelivered(eventId: string, message: TelegramMessage): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client.from('telegram_notifications').upsert({
      event_id: eventId, chat_id: this.chatId, status: 'DELIVERED',
      telegram_message_id: message.messageId, delivered_at: now, updated_at: now,
    }, { onConflict: 'event_id' });
    if (error) throw error;
  }

  async markFailed(eventId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client.from('telegram_notifications').upsert({
      event_id: eventId, chat_id: this.chatId, status: 'FAILED', last_error: reason,
      updated_at: now,
    }, { onConflict: 'event_id' });
    if (error) throw error;
  }
}