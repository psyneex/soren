import { z } from 'zod';
import type { TelegramMessage } from './types.js';

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

export interface TelegramClientOptions {
  botToken: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramClient {
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TelegramClientOptions) {
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
  }

  async getMe(): Promise<{ username?: string }> {
    const response = await this.call('getMe', {});
    return z.object({ username: z.string().optional() }).parse(response.result);
  }

  async discoverChannelChatId(): Promise<string | null> {
    const response = await this.call('getUpdates', { allowed_updates: ['channel_post'] });
    const updates = z.array(z.object({
      channel_post: z.object({ chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string() }) }).optional(),
    })).parse(response.result);
    const channel = updates.find((update) => update.channel_post?.chat.type === 'channel')?.channel_post?.chat;
    return channel ? String(channel.id) : null;
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramMessage> {
    const response = await this.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    const message = z.object({ message_id: z.number(), chat: z.object({ id: z.union([z.number(), z.string()]) }) }).parse(response.result);
    return { messageId: message.message_id, chatId: String(message.chat.id) };
  }

  private async call(method: string, body: Record<string, unknown>): Promise<{ result?: unknown }> {
    const response = await this.requestFetch(`${this.baseUrl}/bot${this.options.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = telegramResponseSchema.parse(await response.json().catch(() => null));
    if (!response.ok || !parsed.ok) {
      throw new TelegramApiError(parsed.description ?? `Telegram request failed with HTTP ${response.status}`, response.status);
    }
    return parsed;
  }
}
