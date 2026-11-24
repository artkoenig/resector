// Session Log events. One JSON object per line in the session file.

export type Kind = 'System' | 'Tools' | 'User' | 'Thinking' | 'Assistant' | 'Tool Call' | 'Tool Result' | 'Note' | 'Image';
// file: an @path snapshot or the project instructions; environment: the environment Note;
// policy: a Note a Context Policy added.
// background: the Note telling a Background Process ended.
export type Origin = 'config' | 'user' | 'model' | 'tool' | 'compaction' | 'file' | 'environment' | 'policy' | 'skill' | 'background';
// How a bash run ended early: Esc killed it, or it ran into the timeout.
export type Stopped = 'killed' | 'timeout';
export type ToolProtocol = 'native';
// The tools the harness runs.
export type Tool = 'bash' | 'websearch' | 'question' | 'skill' | 'image' | 'subagent';
// Reasoning: 'off', 'on', or an effort level the model's chat template accepts (e.g. 'low', 'xhigh').
export type Thinking = string;

// Who made a Context operation: `user` or the Context Policy's name (ADR 0001). Information only: replay never reads it;
// older logs and harness edits carry none.
type By = { by?: string };

// How a Background Process ended: bash's exit code, or the signal that killed it (`SIGTERM`), or why resector stopped
// it: `session ended` (released with its Session), `user` (`k`), `orphaned` (left by a crashed instance).
// report: what a Subagent left for its parent Session.
export type BackgroundEnd = ({ exit: number } | { signal: string }) & { report?: SubagentReport };
// A Subagent's Session (none when it ended before one was opened), the requests of its run and the Context's tokens at
// the last one. outcome: how its run ended, none while it goes on; text: its summary, or the status of an error.
export type SubagentReport = { session?: string; turns: number; tokens: number; outcome?: 'answer' | 'error' | 'aborted' | 'max-turns'; text?: string };

export type Usage = { prompt_tokens: number; completion_tokens: number };

export type SessionEvent =
  // checkout: the directory the session started in; resumed there from any worktree. Absent in older logs.
  | { type: 'SessionCreated'; profile: string; protocol: ToolProtocol; checkout?: string }
  // Resume with a Model Profile missing from the config: the session continues on this one.
  | { type: 'ProfileFallback'; profile: string }
  // Session title; empty = reset to the first User message.
  | { type: 'SessionRenamed'; title: string }
  // Tool Call: content = the bash command, the websearch query or the question's arguments (JSON), `tool` = its tool (absent: bash);
  // Tool Result: `call` = its Tool Call, content = the output (origin user: the answer to a Question).
  // file: the file a Note was read from. Older logs may carry `pin` (ADR 0002): ignored on replay.
  // background: a bash Tool Call run as a Background Process; exited: the Note telling Tool Call `exited`'s Background
  // Process ended.
  | { type: 'BlockAdded'; id: number; kind: Kind; origin: Origin; content: string; tool?: Tool; cutOff?: true; call?: number; stopped?: Stopped; file?: string; background?: true; exited?: number }
  // `@<path>[:a-b]`: a reference row, read only on send (an image file: an Image block) …
  | { type: 'FileReferenced'; id: number; call?: number; file: string }
  // … into a snapshot, never refreshed afterwards; an image into a copy in the Project Home, `image` its name.
  | { type: 'FileRead'; id: number; content: string }
  | { type: 'ImageRead'; id: number; image: string }
  // Tool Call `call` keeps running as a Background Process: its process group `pid`, its output in `log`.
  | { type: 'BackgroundStarted'; call: number; pid: number; log: string }
  // … its process group is empty: the leader's exit code, or what ended it (a signal's name, `session ended`).
  | ({ type: 'BackgroundExited'; call: number } & BackgroundEnd)
  | { type: 'RequestSent'; hash: string; tokens: number }
  // A new Revision of the block's content; the block's first content is Revision 1.
  // harness: the environment Note refreshed or a tool denied by rule taken out of the Tools Block, not undoable.
  | ({ type: 'Edit'; id: number; revision: number; content: string; harness?: true } & By)
  // Context operations; `after` is the block the moved block now follows.
  // Older logs may carry `Pin`/`Unpin` events (ADR 0002): ignored on replay.
  | ({ type: 'Move'; id: number; after: number } & By)
  // Removes the whole Tool Pair when `id` is one of its blocks; `others`: marked blocks removed with it, undone together.
  | ({ type: 'Remove'; id: number; others?: number[] } & By)
  // The Tool Pair of Tool Call `call` becomes Note `id` after the calls and results of its answer.
  | ({ type: 'PairToNote'; id: number; call: number } & By)
  // Accepted Compaction: Note `noteId` with `content` replaces `sources` at the first one's place (a Tool Pair's: after its answer's calls and results).
  | ({ type: 'Compact'; sources: number[]; instruction: string; noteId: number; content: string } & By)
  // A Context Policy's Note `id` with `content` right after block `after`.
  | ({ type: 'NoteAdded'; id: number; after: number; content: string } & By)
  // Skill `name` as a Note `id` with `content`, read from `file`: after the calls and results of `call`'s answer, the
  // skill Notes already there included; without a call (/skill) at the end.
  | { type: 'SkillLoaded'; id: number; call?: number; name: string; file: string; content: string }
  // Display label only, never sent; empty = reset to the default title.
  | { type: 'Rename'; id: number; title: string }
  // "Allow for session": an allow rule for the rest of the session, also after resume.
  | { type: 'AllowRuleAdded'; pattern: string }
  // Thinking for the following requests of the session, instead of the Model Profile's.
  | { type: 'ThinkingSet'; thinking: Thinking }
  // The session runs in its own git worktree (on) or in the project directory (off), also after resume.
  | { type: 'WorktreeSet'; on: boolean }
  // Counter-event: cancels the event at index `eventId` of the Session Log.
  | { type: 'Undo'; eventId: number }
  | { type: 'ResponseReceived'; usage: Usage | null; cached: number | null };

