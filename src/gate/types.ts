// Types of the Review Gate: its options (the ports it runs on), the view it drives and the state it shows.
import type { Rule, Split } from '../core/approval/approval';
import type { Kind, SessionEvent } from '../core/log/events';
import type { Block } from '../core/log/fold';
import type { ReadFile } from '../core/notes/files';
import type { Policy } from '../core/policy/policy';
import type { Question } from '../core/tools/question';
import type { Backend, Clipboard, Editor, Runner, SessionLog } from './ports';

// The view's selection and marks, which the Gate acts on and moves (ADR 0003): the rows shown, the selected block,
// the marked ones. follow moves the selection unless the user reads an older row; release makes it follow again;
// keepSelection moves it onto a shown row. /filter switches a Kind Filter of the view.
export type View = {
  rows: () => number[];
  shown: () => number[];
  hiding: () => boolean;
  selected: () => number;
  selectedBlock: () => Block | undefined;
  setSelected: (id: number) => void;
  selectAt: (index: number) => void;
  keepSelection: () => void;
  follow: (id: number) => void;
  release: () => void;
  marked: () => ReadonlySet<number>;
  setMarked: (ids: ReadonlySet<number>) => void;
  filterBy: (name: string) => void;
};

export type Status = { text: string; tone: 'info' | 'ok' | 'warn' | 'error' };
// events: the Session Log so far (new or resumed); openSessions: shows /sessions; notice: initial status line.
// runner: runs approved bash calls, searcher: search calls; approval: decides which may run; editor: $EDITOR for `e`;
// clipboard: copy on select.
export type GateOptions = {
  backend: Backend;
  runner: Runner;
  searcher: Runner;
  approval: Approval;
  editor: Editor;
  clipboard: Clipboard;
  log: SessionLog;
  events: SessionEvent[];
  project: Project;
  openSessions: () => void;
  notice?: Status;
  // Default Compaction instruction; the Model Profile Compaction runs on, null = the session's own.
  instruction?: () => string;
  compactor?: () => Promise<Compactor | null>;
  policies?: Policies;
  autoApprove?: AutoApprove;
  // Absent outside a git repository: the /git: commands are then not offered.
  git?: Git | null;
};
// Context Policies (ADR 0001): the ones loaded at start, and the active one, which belongs to the app, not the session.
export type Policies = { all: Policy[]; active: () => Policy | null; set: (policy: Policy | null) => void };
// Auto-approve: every call a rule asks for runs without asking; like the active policy it belongs to the app.
export type AutoApprove = { on: () => boolean; set: (on: boolean) => void };
export type Compactor = { profile: string; backend: Backend };
// The project on disk: files for @path references and their completion, the environment Note's text now,
// and $EDITOR on a file of the project (`e` on a reference).
export type Project = { read: ReadFile; list: () => string[]; environment: () => string; open: (path: string) => Promise<void> };
// Tool Approval: the splitter, the project root arguments must stay in, and the config's rules as read
// when the session opened (ignored: project allow patterns).
export type Approval = { split: Split; root: string; permissions: () => { rules: Rule[]; ignored: string[] } };

// The local branches, the current one (null when detached) and those checked out in another worktree, with its path.
export type Branches = { current: string | null; all: string[]; elsewhere: Record<string, string> };

// Git where the session runs: the branches, switching to one and watching for switches; worktree(on) prepares the session's own worktree
// (or the project directory) and returns it, reopen shows the Gate again running there, with a status.
export type Git = {
  branches: () => Branches;
  status: () => boolean;
  switchBranch: (name: string) => void;
  watch: (onChange: () => void) => () => void;
  worktree: (on: boolean) => string;
  reopen: (notice: Status) => void;
};

// In-flight answer, its reasoning apart; never persisted until complete or aborted.
export type Streaming = { thinking: string; text: string; abort: AbortController };
// Approved Tool Call running; its output so far is shown, the result is logged when it ends. timeout: its tool's.
export type Running = { call: Block; output: string; started: number; timeout: number; abort: AbortController };
// A Question awaiting the user's answer in the dock: its Tool Call and questions.
export type Asked = { call: Block; questions: Question[] };
// The row of an answer or result not in the Context yet, shown before the block `before` (null: at the end).
// A proposal has its own title, heading and, once counted, tokens.
export type Live = { id: number; kind: Kind; content: string; before: number | null; title?: string; heading?: string; tokens?: number };
// What accepting the proposal changes: tokens and Context (over: not below the window), and the cache.
export type Review = { tokens: string; over: boolean; cache: string; cold: boolean };
// Compaction under way: the instruction being written, the proposal streaming, or under review.
export type Compaction = Compactor & {
  sources: number[];
  // Runs on the session's backend (same model/slot), which leaves the session cache cold.
  same: boolean;
  phase: 'instruction' | 'running' | 'review';
  attempt: number;
  instruction: string;
  // What the instruction line shows when it opens again: the draft of the last run.
  draft: string;
  text: string;
  abort: AbortController | null;
  // Tokens of the request with the instruction being written.
  request: number | null;
  // The proposal counted in the Context: the Note's tokens and the Context total.
  after: { note: number; total: number } | null;
};
