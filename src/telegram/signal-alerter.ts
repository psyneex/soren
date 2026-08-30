/**
 * Adapter: turns monitor state transitions into dedupe-safe Telegram events.
 */
import type { SignalAlerter, SignalNotification } from '../monitor/cycle.js';
import { TelegramAlerting } from './alerting.js';
import type { SignalEvent, TelegramSignalType } from './types.js';

const EVENT_TYPE_BY_STATE: Partial<Record<string, TelegramSignalType>> = {
  WATCH: 'WATCH',
  BUY_CANDIDATE: 'BUY',
  ACTIVE_WATCH: 'ACTIVE_WATCH',
  HOLD: 'HOLD',
  TAKE_PROFIT: 'TAKE_PROFIT',
  STOP_LOSS: 'STOP_LOSS',
  EXIT: 'EXIT',
  INVALIDATED: 'INVALIDATED',
};

const EXIT_STATES = new Set(['TAKE_PROFIT', 'STOP_LOSS', 'EXIT', 'INVALIDATED']);

export class TelegramSignalAlerter implements SignalAlerter {
  constructor(private readonly alerting: TelegramAlerting) {}

  async notify(notification: SignalNotification): Promise<void> {
    const type = EVENT_TYPE_BY_STATE[notification.toState];
    if (!type) return; // No Telegram mapping for this state; nothing to send.

    const event: SignalEvent = {
      eventId: `watch:${notification.tokenId}:${notification.snapshotId}:${notification.toState}`,
      type,
      token: notification.symbol ?? notification.tokenAddress,
      chain: notification.chain,
      signalTimestamp: notification.observedAt,
      previousState: notification.fromState,
      newState: notification.toState,
      trigger: notification.reason,
      goldenScore: notification.score,
      formulaVersion: notification.formulaVersion,
      components: notification.components,
      gatesVerdict: notification.gatesVerdict,
      entryPrice: notification.entryPrice,
      currentPrice: notification.currentPrice,
      exitReason: EXIT_STATES.has(type) ? notification.reason : undefined,
      evidence: { evaluationStatus: notification.evaluationStatus },
    };
    await this.alerting.send(event);
  }
}
