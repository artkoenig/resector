// Backend port: what the Review Gate needs from a model server. Adapters implement it.
import type { Thinking, Usage } from './log/events';
import type { Request } from './render/native';
import type { RawCall } from './tools/call';
import type { TokenSplit } from './tokens/split';

export type Finish = 'stop' | 'tool_calls' | 'length' | 'aborted';
// thinking: the model's reasoning; calls: tool calls of the answer, in order; cached: prompt tokens the server reports as reused;
// predicted: what the prediction expected (verification).
export type ChatResult = { thinking: string; content: string; calls: RawCall[]; finish: Finish; usage: Usage | null; cached: number | null; predicted: number | null };
// onThinking: reasoning as it streams; maxTokens: the window minus the Context, no reserve –
// the Gate always sets it, without it the server's default applies.
export type ChatOptions = { signal: AbortSignal; onDelta: (text: string) => void; onThinking?: (text: string) => void; maxTokens?: number };
// Prompt tokens the server will reuse from its prefix cache; not exact = approximate.
export type CacheHit = { tokens: number; exact: boolean };
export type Counted = TokenSplit & { cached: CacheHit };

// thinking: what requests without their own are sent with (the Model Profile's); thinkingModes:
// what the model's chat template offers, null when it is not known.
export type Backend = {
  window: number;
  thinking?: Thinking;
  thinkingModes?: Thinking[] | null;
  // Token counts are exact; an inexact backend's last drift is subtracted from the window.
  exact: boolean;
  // prefixes: the request rendered for the first 1, 2, … blocks (renderPrefixes); the last is the request.
  count(prefixes: Request[]): Promise<Counted>;
  chat(request: Request, options: ChatOptions): Promise<ChatResult>;
};
