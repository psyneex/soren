import type { SignalEvent } from './types.js';

function scoreLine(event: SignalEvent): string {
  const score = event.goldenScore == null ? 'n/a' : event.goldenScore.toFixed(2);
  return `Golden Score: ${score}${event.formulaVersion ? ` (${event.formulaVersion})` : ''}`;
}

function components(event: SignalEvent): string {
  if (!event.components || Object.keys(event.components).length === 0) return 'Components: n/a';
  return `Components: ${Object.entries(event.components)
    .map(([key, value]) => `${key}=${value == null ? 'n/a' : value.toFixed(1)}`)
    .join(', ')}`;
}

function evidence(event: SignalEvent): string {
  if (!event.evidence || Object.keys(event.evidence).length === 0) return 'Evidence: n/a';
  return `Evidence: ${Object.entries(event.evidence)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')}`;
}

function price(value: number | null | undefined): string {
  return value == null ? 'n/a' : String(value);
}

export function formatSignalEvent(event: SignalEvent): string {
  if (event.type === 'SYSTEM') {
    return `SYSTEM ALERT\n${event.message ?? 'System event'}\nTimestamp: ${event.signalTimestamp}`;
  }

  const isEntry = event.type === 'BUY';
  const isExit = ['EXIT', 'TAKE_PROFIT', 'STOP_LOSS', 'INVALIDATED'].includes(event.type);
  const title = isEntry ? 'BUY SIGNAL' : isExit ? `${event.type} ALERT` : `${event.type} STATE`;

  const lines = [
    title,
    `Token: ${event.token}`,
    `Chain: ${event.chain ?? 'n/a'}`,
    `State: ${event.previousState ?? '?'} → ${event.newState ?? event.type}`,
    `Timestamp: ${event.signalTimestamp}`,
    scoreLine(event),
    components(event),
    `Gates: ${event.gatesVerdict ?? 'n/a'}`,
  ];

  if (isEntry) {
    lines.push(`Entry reference: ${price(event.entryPrice)}`);
  }
  if (isExit) {
    lines.push(
      `Exit reason: ${event.exitReason ?? event.trigger ?? 'n/a'}`,
      `Entry: ${price(event.entryPrice)} → Current: ${price(event.currentPrice)}` +
        (event.trackedReturnPct != null ? ` (${event.trackedReturnPct.toFixed(2)}%)` : ''),
    );
  }
  lines.push(evidence(event));
  return lines.join('\n');
}
