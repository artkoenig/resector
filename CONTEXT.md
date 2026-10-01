# Resector

Coding agent harness for local LLMs with small context windows. The user sees, measures and edits everything sent to the model.

## Language

### Context Curation

**Context**:
The ordered list of Context Blocks sent in the next request.
_Avoid_: prompt, history, window

**Context Block**:
Smallest addressable unit of what is sent to the model. Kinds: System, Tools, User, Thinking, Assistant, Tool Call, Tool Result, Note. Has a stable identity across Revisions and a token count (rendered, including role markers); can be edited, moved, removed (undoable), compacted.
_Avoid_: message, chunk, segment

**Revision**:
One version of a Context Block's content. Editing creates a new Revision; earlier Revisions stay in the Session Log and can be restored.

**Tools Block**:
Context Block holding the tool definitions offered to the model. Always first after System; never edited.

**Tool Pair**:
A Tool Call together with its Tool Result. Removed or compacted only as a whole; moving it turns the pair into a single Note.

**Thinking**:
Context Block holding the model's reasoning for one answer, placed before that answer. Stays in the Context until the user removes it; the model's chat template may still drop it from the rendered request.
_Avoid_: reasoning, chain of thought

**Note**:
Context Block of free text without API role semantics, keeping a reference to its origin: a moved Tool Pair, a Compaction result, a Context Policy, the Environment Note, Project Instructions or a File Reference.

**File Reference**:
`@<path>` (optionally with a line range) in the user's input: a Note that shows the file as it is now until the Context is sent, then becomes a snapshot that is never refreshed. A file missing at send stops the send.
_Avoid_: mention, attachment

**Environment Note**:
Note describing where the Session runs (working directory, OS and shell, date, branch), right after the Tools Block. The harness refreshes it in place, as a new Revision, when it changes.

**Project Instructions**:
Notes holding `AGENTS.md` and `CLAUDE.md` at the root of the checkout the Session runs in, then the user's own from the Project Home, one per file, read once when the Session starts.

**Compaction**:
Rewrite of selected Context Blocks by the LLM, following an instruction, into one Note at the position of the first source. The model sees only the selected blocks and the instruction. Started by the user, who reviews the proposal and accepts, discards or refines it (refine starts again from the sources), or by a Context Policy, whose result is accepted without review. On accept the sources count as removed; undo brings them back.
_Avoid_: summarization, auto-compact

**Context Policy**:
Named set of rules that edits the Context automatically, using only the ordinary Context operations and adding a Note of its own, e.g. to tell the model what it does. Applied before every request; its operations are recorded in the Session Log like the user's, attributed to the policy and visible at the Review Gate. An undone operation is applied again before the next request as long as the policy is active. At most one is active at a time; it belongs to the running app rather than to a Session: a new Session switches the configured default on, a resumed one keeps the app's, and the user switches it at the Review Gate. Context operations in the Session Log name who made them: the user or the policy; the Session does not depend on it.
_Avoid_: mode, strategy, autopilot, auto-compact

### Review Gate

**Review Gate**:
Pause before a request to the model where the user inspects the Context and sends, edits, or compacts it: before every request the user sends, and whenever the Tool Loop is held.
_Avoid_: breakpoint, approval

**Tool Loop**:
The follow-up requests after an answer with Tool Calls: its calls are decided in order, run, and their results sent, until the model answers without calls or the loop is held.

**Hold**:
Stop of the Tool Loop at the Review Gate with the results unsent, for the user to review: asked for with Esc, or because a call was not run (rejected, denied) or was stopped (killed, timeout).
_Avoid_: pause, break

**Kind Filter**:
View restriction at the Review Gate by Kind: System (with the Tools Block), User, Thinking, Assistant, Note, or Tool Calls with their Tool Results (never one without the other). Each is switched on or off on its own; the blocks shown are those of the Kinds on. Tool Calls are off at start; a Tool Call awaiting approval or running is shown regardless. Changes nothing about the Context and is not recorded in the Session Log.
_Avoid_: search, hide

### Measurement

**Budget**:
What the next answer may use: the window minus the Context's tokens. A Context that leaves no Budget cannot be sent.

**Warm Block**:
Context Block still in the backend's prefix cache from the last request, so sending it again costs no prompt processing. An edit before it makes it and all blocks after it cold.
_Avoid_: cached block

### Tooling

**Tool Approval**:
Decision whether a Tool Call the model requested may run, taken before execution by Permission Rules or by the user at the Review Gate. Distinct from the Review Gate itself, which sits before the request.
_Avoid_: permission prompt

**Permission Rule**:
Pattern over a bash sub-command with an action (`allow`, `ask`, `deny`) and a source, in this order: built-in, global config, project config (from the Project Home), Session Rule. The last matching rule decides; none matching means `ask`.

**Session Rule**:
Permission Rule with action `allow` the user adds while approving a Tool Call, valid for the rest of the Session, also after resume.
_Avoid_: allow for session

**Auto-approve**:
Switch under which every Tool Call the Permission Rules would `ask` for runs without asking; `deny` still applies. Like the Context Policy it belongs to the running app, not to a Session.
_Avoid_: yolo, trust mode

**Question**:
Tool Call in which the model asks the user one or more questions, each with at least two options, at least one of them the Recommended Option, and always allowing a free-text answer. A Question without a valid Recommended Option is rejected back to the model and never reaches the user. The user answers, skips single questions or declines as a whole; the answer becomes its Tool Result, written by the user instead of a tool. Never needs Tool Approval, but Permission Rules can switch it off.
_Avoid_: prompt, ask, approval

### Sessions & Workspace

**Project**:
A git repository with all its worktrees, identified by its main checkout wherever resector starts inside it; without git, the directory resector starts in. A moved repository is a new Project.
_Avoid_: workspace, repo (for the unit)

**Project Home**:
The user's own directory for a Project, outside it and named after its main checkout's path: the user's instructions, config, Session Logs and Session Worktrees for the Project. Nothing in the Project itself is written by resector.

**Session**:
One conversation in a Project, recorded in its own Session Log. Can be listed, resumed, renamed and deleted as a whole; there is no forking. Shared by all checkouts of the Project; resumed, it runs in the checkout it ran in, or the current one when that is gone. Its title is the first user message unless renamed.

**Session Log**:
Complete, append-only sequence of events of a session: blocks added (by user, model or tool) and Context operations (edit, move, remove, compact). The Context is derived by replaying it; undo is a counter-event. Nothing is ever deleted.
_Avoid_: history, transcript

**Session Worktree**:
Git worktree of its own, in the Project Home, in which a Session runs instead of the project directory, so its tools change nothing there. Switched per Session and kept after resume; removed with its Session, its branch only when merged.

**Model Profile**:
Per-model settings: backend, endpoint, tokenizer, window size, Tool Protocol, tool result format, sampling, thinking at session start (off, on or effort level; switchable at the Review Gate), and optionally another Model Profile used for Compaction (default: the same). Fixed for a session; only when it is gone from the config at resume does the session fall back to the default Model Profile.

### Inference

**Tool Protocol**:
How tool definitions and tool calls travel between harness and model: `native` (API tool calling) or `text-xml` (defined in the prompt). Blocks are stored protocol-neutral; the protocol only affects rendering of a request.
