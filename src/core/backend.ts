// Backend port: what the Review Gate needs from a model server. Adapters implement it (architecture §2).
import type { Usage } from './log/events';
import type { Request } from './render/native';
import type { RawCall } from './toolcall/bash';
import type { TokenSplit } from './tokens/split';

export type Finish = 'stop' | 'tool_calls' | 'length' | 'aborted';
// thinking: the model's reasoning (FR-46); calls: tool calls of the answer, in order; cached: prompt tokens the server reports as reused;
// predicted: what the prediction expected (verification, FR-3).
export type ChatResult = { thinking: string; content: string; calls: RawCall[]; finish: Finish; usage: Usage | null; cached: number | null; predicted: number | null };
// onThinking: reasoning as it streams (FR-50); maxTokens: the window minus the Context, no reserve (FR-18) –
// the Gate always sets it, without it the server's default applies.
export type ChatOptions = { signal: AbortSignal; onDelta: (text: string) => void; onThinking?: (text: string) => void; maxTokens?: number };
// Prompt tokens the server will reuse from its prefix cache (FR-3); not exact = approximate (NFR-2).
export type CacheHit = { tokens: number; exact: boolean };
export type Counted = TokenSplit & { cached: CacheHit };

export type Backend = {
  window: number;
  // Token counts are exact (NFR-1); an inexact backend's last drift is subtracted from the window (FR-18).
  exact: boolean;
  // prefixes: the request rendered for the first 1, 2, … blocks (renderPrefixes); the last is the request.
  count(prefixes: Request[]): Promise<Counted>;
  chat(request: Request, options: ChatOptions): Promise<ChatResult>;
};
