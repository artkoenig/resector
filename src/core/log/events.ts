// Session Log events (architecture §3). One JSON object per line in the session file.

export type Kind = 'System' | 'User' | 'Assistant';
export type Origin = 'config' | 'user' | 'model';
export type ToolProtocol = 'native';

// Pin top = after System (FR-10); bottom = very end, sent as user-role Note.
export type Pin = 'top' | 'bottom';

export type Usage = { prompt_tokens: number; completion_tokens: number };

export type SessionEvent =
  | { type: 'SessionCreated'; profile: string; protocol: ToolProtocol }
  // Resume with a Model Profile missing from the config: the session continues on this one (FR-35).
  | { type: 'ProfileFallback'; profile: string }
  // Session title; empty = reset to the first User message (FR-34).
  | { type: 'SessionRenamed'; title: string }
  | { type: 'BlockAdded'; id: number; kind: Kind; origin: Origin; content: string; cutOff?: true }
  | { type: 'RequestSent'; hash: string; tokens: number }
  // Context operations (FR-4, FR-10); `after` is the block the moved block now follows.
  | { type: 'Move'; id: number; after: number }
  | { type: 'Pin'; id: number; at: Pin }
  | { type: 'Unpin'; id: number }
  | { type: 'Remove'; id: number }
  // Display label only, never sent; empty = reset to the default title.
  | { type: 'Rename'; id: number; title: string }
  // Counter-event (NFR-3): cancels the event at index `eventId` of the Session Log.
  | { type: 'Undo'; eventId: number }
  | { type: 'ResponseReceived'; usage: Usage | null; cached: number | null };

// Session Log port: where events are persisted (adapters/store).
export type SessionLog = { append: (event: SessionEvent) => void };
