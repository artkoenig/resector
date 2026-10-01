// Ports the Gate runs on and adapters implement: the model server, the runners, $EDITOR, the Session Log, the clipboard.
import type { SessionEvent, Thinking } from '../core/log/events';
import type { Request } from '../core/render/native';
import type { TokenSplit } from '../core/tokens/split';
import type { ChatResult } from '../core/tools/answer';
import type { RunResult } from '../core/tools/call';

// onThinking: reasoning as it streams; onToken: a stream event with generated output (reasoning, text or a call's
// pieces), about one token; maxTokens: the window minus the Context, no reserve – the Gate always sets it,
// without it the server's default applies.
export type ChatOptions = {
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onThinking?: (text: string) => void;
  onToken?: () => void;
  maxTokens?: number;
};
// Prompt tokens the server will reuse from its prefix cache; not exact = approximate.
export type CacheHit = { tokens: number; exact: boolean };
export type Counted = TokenSplit & { cached: CacheHit };

// A model server (adapters/backend). thinking: what requests without their own are sent with (the Model Profile's);
// thinkingModes: what the model's chat template offers, null when it is not known.
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

// Runs a command, streaming its output; aborting the signal kills it (adapters/bash, adapters/search).
// timeout: seconds after which a run is stopped.
export type RunOptions = { signal: AbortSignal; onOutput: (text: string) => void };
export type Runner = { timeout: number; run(command: string, options: RunOptions): Promise<RunResult> };

// The user edits a text; resolves to the saved text (adapters/editor).
export type Editor = (text: string) => Promise<string>;
// Where events are persisted (adapters/store).
export type SessionLog = { append: (event: SessionEvent) => void };
// Copies a text to the system clipboard.
export type Clipboard = (text: string) => Promise<void>;
