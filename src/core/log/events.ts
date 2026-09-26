// Session Log events (architecture §3). One JSON object per line in the session file.

export type Kind = 'System' | 'Tools' | 'User' | 'Thinking' | 'Assistant' | 'Tool Call' | 'Tool Result' | 'Note';
// file: an @file snapshot or the project instructions (FR-27, FR-29); environment: the environment Note (FR-28).
export type Origin = 'config' | 'user' | 'model' | 'tool' | 'compaction' | 'file' | 'environment';
// How a bash run ended early (FR-21): Esc killed it, or it ran into the timeout.
export type Stopped = 'killed' | 'timeout';
export type ToolProtocol = 'native';

// Pin top = after System and Tools Block (FR-10); bottom = very end, sent as user-role Note.
export type Pin = 'top' | 'bottom';

export type Usage = { prompt_tokens: number; completion_tokens: number };

export type SessionEvent =
  | { type: 'SessionCreated'; profile: string; protocol: ToolProtocol }
  // Resume with a Model Profile missing from the config: the session continues on this one (FR-35).
  | { type: 'ProfileFallback'; profile: string }
  // Session title; empty = reset to the first User message (FR-34).
  | { type: 'SessionRenamed'; title: string }
  // Tool Call: content = the bash command; Tool Result: `call` = its Tool Call, content = the output.
  // file: the file a Note was read from; pin: added pinned (environment Note, project instructions).
  | { type: 'BlockAdded'; id: number; kind: Kind; origin: Origin; content: string; cutOff?: true; call?: number; stopped?: Stopped; file?: string; pin?: Pin }
  // `@file <path>[:a-b]` (FR-27): a reference row, read only on send …
  | { type: 'FileReferenced'; id: number; file: string }
  // … into a snapshot, never refreshed afterwards.
  | { type: 'FileRead'; id: number; content: string }
  | { type: 'RequestSent'; hash: string; tokens: number }
  // A new Revision of the block's content (FR-8); the block's first content is Revision 1.
  // harness: the environment Note refreshed (FR-28), not undoable.
  | { type: 'Edit'; id: number; revision: number; content: string; harness?: true }
  // Context operations (FR-4, FR-10); `after` is the block the moved block now follows.
  | { type: 'Move'; id: number; after: number }
  | { type: 'Pin'; id: number; at: Pin }
  | { type: 'Unpin'; id: number }
  // Removes the whole Tool Pair when `id` is one of its blocks (FR-9).
  | { type: 'Remove'; id: number }
  // The Tool Pair of Tool Call `call` becomes Note `id` after the calls and results of its answer (FR-9).
  | { type: 'PairToNote'; id: number; call: number }
  // Accepted Compaction (FR-16): Note `noteId` with `content` replaces `sources` at the first one's place.
  | { type: 'Compact'; sources: number[]; instruction: string; noteId: number; content: string }
  // Display label only, never sent; empty = reset to the default title.
  | { type: 'Rename'; id: number; title: string }
  // "Allow for session" (FR-23, FR-25): an allow rule for the rest of the session, also after resume.
  | { type: 'AllowRuleAdded'; pattern: string }
  // Counter-event (NFR-3): cancels the event at index `eventId` of the Session Log.
  | { type: 'Undo'; eventId: number }
  | { type: 'ResponseReceived'; usage: Usage | null; cached: number | null };

// Session Log port: where events are persisted (adapters/store).
export type SessionLog = { append: (event: SessionEvent) => void };
