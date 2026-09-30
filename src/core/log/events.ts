// Session Log events (architecture §3). One JSON object per line in the session file.

export type Kind = 'System' | 'Tools' | 'User' | 'Thinking' | 'Assistant' | 'Tool Call' | 'Tool Result' | 'Note';
// file: an @path snapshot or the project instructions (FR-27, FR-29); environment: the environment Note (FR-28);
// policy: a Note a Context Policy added (FR-52).
export type Origin = 'config' | 'user' | 'model' | 'tool' | 'compaction' | 'file' | 'environment' | 'policy';
// How a bash run ended early (FR-21): Esc killed it, or it ran into the timeout.
export type Stopped = 'killed' | 'timeout';
export type ToolProtocol = 'native';
// The tools the harness runs (FR-21).
export type Tool = 'bash' | 'search' | 'question';
// Reasoning (FR-49): 'off', 'on', or an effort level the model's chat template accepts (e.g. 'low', 'xhigh').
export type Thinking = string;

// Who made a Context operation: `user` or the Context Policy's name (ADR 0001). Information only: replay never reads it;
// older logs and harness edits carry none.
type By = { by?: string };

export type Usage = { prompt_tokens: number; completion_tokens: number };

export type SessionEvent =
  | { type: 'SessionCreated'; profile: string; protocol: ToolProtocol }
  // Resume with a Model Profile missing from the config: the session continues on this one (FR-35).
  | { type: 'ProfileFallback'; profile: string }
  // Session title; empty = reset to the first User message (FR-34).
  | { type: 'SessionRenamed'; title: string }
  // Tool Call: content = the bash command, the search query or the question's arguments (JSON), `tool` = its tool (absent: bash);
  // Tool Result: `call` = its Tool Call, content = the output (origin user: the answer to a Question).
  // file: the file a Note was read from. Older logs may carry `pin` (ADR 0002): ignored on replay.
  | { type: 'BlockAdded'; id: number; kind: Kind; origin: Origin; content: string; tool?: Tool; cutOff?: true; call?: number; stopped?: Stopped; file?: string }
  // `@<path>[:a-b]` (FR-27): a reference row, read only on send …
  | { type: 'FileReferenced'; id: number; file: string }
  // … into a snapshot, never refreshed afterwards.
  | { type: 'FileRead'; id: number; content: string }
  | { type: 'RequestSent'; hash: string; tokens: number }
  // A new Revision of the block's content (FR-8); the block's first content is Revision 1.
  // harness: the environment Note refreshed (FR-28) or a tool denied by rule taken out of the Tools Block (FR-21), not undoable.
  | ({ type: 'Edit'; id: number; revision: number; content: string; harness?: true } & By)
  // Context operations (FR-4); `after` is the block the moved block now follows.
  // Older logs may carry `Pin`/`Unpin` events (ADR 0002): ignored on replay.
  | ({ type: 'Move'; id: number; after: number } & By)
  // Removes the whole Tool Pair when `id` is one of its blocks (FR-9); `others`: marked blocks removed with it, undone together.
  | ({ type: 'Remove'; id: number; others?: number[] } & By)
  // The Tool Pair of Tool Call `call` becomes Note `id` after the calls and results of its answer (FR-9).
  | ({ type: 'PairToNote'; id: number; call: number } & By)
  // Accepted Compaction (FR-16): Note `noteId` with `content` replaces `sources` at the first one's place.
  | ({ type: 'Compact'; sources: number[]; instruction: string; noteId: number; content: string } & By)
  // A Context Policy's Note `id` with `content` right after block `after` (FR-52).
  | ({ type: 'NoteAdded'; id: number; after: number; content: string } & By)
  // Display label only, never sent; empty = reset to the default title.
  | { type: 'Rename'; id: number; title: string }
  // "Allow for session" (FR-23, FR-25): an allow rule for the rest of the session, also after resume.
  | { type: 'AllowRuleAdded'; pattern: string }
  // Thinking for the following requests of the session, instead of the Model Profile's (FR-49).
  | { type: 'ThinkingSet'; thinking: Thinking }
  // The session runs in its own git worktree (on) or in the project directory (off), also after resume.
  | { type: 'WorktreeSet'; on: boolean }
  // Counter-event (NFR-3): cancels the event at index `eventId` of the Session Log.
  | { type: 'Undo'; eventId: number }
  | { type: 'ResponseReceived'; usage: Usage | null; cached: number | null };

// Session Log port: where events are persisted (adapters/store).
export type SessionLog = { append: (event: SessionEvent) => void };
