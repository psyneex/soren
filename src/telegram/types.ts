/**
 * Telegram signal events for the monitoring phase. A message is emitted only
 * for a meaningful watch-state transition (AGENTS.md Telegram section); the
 * eventId is deterministic per (token, snapshot, state) so the notification
 * store can suppress duplicate deliveries.
 */
export type TelegramSignalType =
  | 'BUY'
  | 'HOLD'
  | 'WATCH'
  | 'ACTIVE_WATCH'
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'EXIT'
  | 'INVALIDATED'
  | 'SYSTEM';

export interface SignalEvent {
  eventId: string;
  type: TelegramSignalType;
  /** Token symbol when known, otherwise the on-chain address. */
  token: string;
  chain?: string;
  signalTimestamp: string;
  previousState?: string;
  newState?: string;
  /** Watch-state transition reason / triggering condition. */
  trigger?: string;
  /** Golden Formula score — an interpretable proxy, not a probability. */
  goldenScore?: number | null;
  formulaVersion?: string;
  components?: Record<string, number | null>;
  gatesVerdict?: string;
  entryPrice?: number | null;
  currentPrice?: number | null;
  trackedReturnPct?: number | null;
  exitReason?: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface TelegramMessage {
  messageId: number;
  chatId: string;
}
