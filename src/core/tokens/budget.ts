// Budget (FR-2, FR-18): max_tokens, the warning near the window, sending blocked at a full window, and the
// drift of an inexact tokenizer (architecture §4 "Token counting").
import type { SessionEvent } from '../log/events';

// The drift last measured: prompt tokens the server reported − the tokens counted before sending that request;
// null before the first answer with usage. A Model Profile fallback (FR-35) counts with another tokenizer: none yet.
export function lastDrift(events: SessionEvent[]): number | null {
  let counted: number | null = null;
  let drift: number | null = null;
  for (const e of events) {
    if (e.type === 'RequestSent') counted = e.tokens;
    if (e.type === 'ProfileFallback') drift = null;
    if (e.type !== 'ResponseReceived') continue;
    if (e.usage && counted !== null) drift = e.usage.prompt_tokens - counted;
    counted = null;
  }
  return drift;
}

// total: the Context's tokens; exact: the backend counts exactly, drift is then ignored.
export type BudgetInput = { total: number; window: number; exact: boolean; drift: number | null };
// maxTokens: what the answer may use, no reserve; over: tokens to shed before sending, 0 = sendable;
// driftLabel: the header's `±X` for an inexact tokenizer, null for an exact one.
export type Budget = { maxTokens: number; over: number; tone: 'ok' | 'warn' | 'over'; driftLabel: string | null };

export function budget({ total, window, exact, drift }: BudgetInput): Budget {
  const margin = exact ? 0 : Math.abs(drift ?? 0);
  const over = Math.max(0, total - (window - margin) + 1);
  const tone = over ? 'over' : total >= 0.9 * window ? 'warn' : 'ok';
  return { maxTokens: window - total, over, tone, driftLabel: exact ? null : drift === null ? '±?' : `±${Math.abs(drift)}` };
}
