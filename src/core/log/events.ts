// Session Log events (architecture §3). One JSON object per line in the session file.

export type Kind = 'System' | 'User' | 'Assistant';
export type Origin = 'config' | 'user' | 'model';
export type ToolProtocol = 'native';

export type Usage = { prompt_tokens: number; completion_tokens: number };

export type SessionEvent =
  | { type: 'SessionCreated'; profile: string; protocol: ToolProtocol }
  | { type: 'BlockAdded'; id: number; kind: Kind; origin: Origin; content: string; cutOff?: true }
  | { type: 'RequestSent'; hash: string; tokens: number }
  | { type: 'ResponseReceived'; usage: Usage | null; cached: number | null };

// Session Log port: where events are persisted (adapters/store).
export type SessionLog = { append: (event: SessionEvent) => void };
