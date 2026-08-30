import { describe, expect, it, vi } from 'vitest';
import { TelegramAlerting } from '../src/telegram/alerting.js';
import { TelegramClient } from '../src/telegram/client.js';
import { formatSignalEvent } from '../src/telegram/formatter.js';
import type { SignalEvent } from '../src/telegram/types.js';

const buyEvent: SignalEvent = {
  eventId: 'watch:1:s1:BUY_CANDIDATE',
  type: 'BUY',
  token: 'ABC',
  chain: 'solana',
  signalTimestamp: '2026-08-27T12:00:00Z',
  previousState: 'WATCH',
  newState: 'BUY_CANDIDATE',
  goldenScore: 84,
  formulaVersion: 'golden_formula_v0',
  components: { smartMoneyAccumulation: 80, accumulationAcceleration: 70, relativeStrength: 60, volumeConfirmation: 55, marketRegime: 50 },
  gatesVerdict: 'PASS',
  evidence: { reason: 'buy_candidate_qualified' },
};

describe('Telegram alerting', () => {
  it('formats BUY and exit events distinctly', () => {
    expect(formatSignalEvent(buyEvent)).toContain('BUY SIGNAL');
    expect(formatSignalEvent({ ...buyEvent, type: 'EXIT', previousState: 'ACTIVE_WATCH', newState: 'EXIT', exitReason: 'score_below_exit_threshold' }))
      .toContain('EXIT ALERT');
  });

  it('formats the Golden Score with its formula version', () => {
    const text = formatSignalEvent(buyEvent);
    expect(text).toContain('Golden Score: 84');
    expect(text).toContain('golden_formula_v0');
    expect(text).toContain('WATCH → BUY_CANDIDATE');
  });

  it('discovers channel IDs from channel posts', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [{ channel_post: { chat: { id: -1001, type: 'channel' } } }] }), { status: 200 }));
    const client = new TelegramClient({ botToken: 'test-token', fetch: fetchMock });
    await expect(client.discoverChannelChatId()).resolves.toBe('-1001');
  });

  it('delivers once and skips duplicates', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: -1001 } } }), { status: 200 }));
    const client = new TelegramClient({ botToken: 'test-token', fetch: fetchMock });
    const delivered = new Set<string>();
    const store = {
      find: vi.fn(async (eventId: string) => delivered.has(eventId) ? { delivered: true, messageId: 7 } : null),
      markDelivered: vi.fn(async (eventId: string) => { delivered.add(eventId); }),
      markFailed: vi.fn(),
    };
    const alerting = new TelegramAlerting(client, '-1001', store);

    await expect(alerting.send(buyEvent)).resolves.toEqual({ messageId: 7, chatId: '-1001' });
    await expect(alerting.send(buyEvent)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
