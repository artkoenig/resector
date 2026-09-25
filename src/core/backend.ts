// Backend port: what the Review Gate needs from a model server. Adapters implement it (architecture §2).
import type { Usage } from './log/events';
import type { Message } from './render/native';
import type { TokenSplit } from './tokens/split';

export type Finish = 'stop' | 'length' | 'aborted';
// cached: prompt tokens the server reports as reused; predicted: what the prediction expected (verification, FR-3).
export type ChatResult = { content: string; finish: Finish; usage: Usage | null; cached: number | null; predicted: number | null };
export type ChatOptions = { signal: AbortSignal; onDelta: (text: string) => void };
// Prompt tokens the server will reuse from its prefix cache (FR-3); not exact = approximate (NFR-2).
export type CacheHit = { tokens: number; exact: boolean };
export type Counted = TokenSplit & { cached: CacheHit };

export type Backend = {
  window: number;
  count(messages: Message[]): Promise<Counted>;
  chat(messages: Message[], options: ChatOptions): Promise<ChatResult>;
};
