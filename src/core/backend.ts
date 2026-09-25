// Backend port: what the Review Gate needs from a model server. Adapters implement it (architecture §2).
import type { Usage } from './log/events';
import type { Message } from './render/native';
import type { TokenSplit } from './tokens/split';

export type Finish = 'stop' | 'length' | 'aborted';
export type ChatResult = { content: string; finish: Finish; usage: Usage | null; cached: number | null };
export type ChatOptions = { signal: AbortSignal; onDelta: (text: string) => void };

export type Backend = {
  window: number;
  count(messages: Message[]): Promise<TokenSplit>;
  chat(messages: Message[], options: ChatOptions): Promise<ChatResult>;
};
