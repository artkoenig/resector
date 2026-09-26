# Resector

Coding agent harness for local LLMs with small context windows. The user sees, measures and edits everything sent to the model.

## Language

**Context Block**:
Smallest addressable unit of what is sent to the model. Kinds: System, Tools, User, Thinking, Assistant, Tool Call, Tool Result, Note. Has a stable identity across Revisions and a token count (rendered, including role markers); can be edited, moved, pinned, removed (undoable), compacted.
_Avoid_: message, chunk, segment

**Revision**:
One version of a Context Block's content. Editing creates a new Revision; earlier Revisions stay in the Session Log and can be restored.

**Tools Block**:
Context Block holding the tool definitions offered to the model. Always first after System; never edited.

**Tool Pair**:
A Tool Call together with its Tool Result. Removed or compacted only as a whole; moving it turns the pair into a single Note.

**Session**:
One conversation in a project, recorded in its own Session Log. Can be listed, resumed, renamed and deleted as a whole; there is no forking. Its title is the first user message unless renamed.

**Context**:
The ordered list of Context Blocks sent in the next request.
_Avoid_: prompt, history, window

**Session Log**:
Complete, append-only sequence of events of a session: blocks added (by user, model or tool) and Context operations (edit, move, pin, unpin, remove, compact). The Context is derived by replaying it; undo is a counter-event. Nothing is ever deleted.
_Avoid_: history, transcript

**Review Gate**:
Pause before every request to the model (including follow-up requests inside a tool loop) where the user inspects the Context and sends, edits, or compacts it.
_Avoid_: breakpoint, approval

**Tool Approval**:
Decision whether a Tool Call the model requested may run, taken before execution by Permission Rules (`allow`, `ask`, `deny`) or by the user at the Review Gate. Distinct from the Review Gate itself, which sits before the request.
_Avoid_: permission prompt

**Question**:
Tool Call in which the model asks the user one or more questions, each with at least two options, at least one of them the Recommended Option, and always allowing a free-text answer. A Question without a valid Recommended Option is rejected back to the model and never reaches the user. The user answers, skips single questions or declines as a whole; the answer becomes its Tool Result, written by the user instead of a tool. Never needs Tool Approval, but Permission Rules can switch it off.
_Avoid_: prompt, ask, approval

**Compaction**:
User-controlled rewrite of selected Context Blocks by the LLM, following a user instruction, into one Note at the position of the first source. The model sees only the selected blocks and the instruction. The user reviews the proposal and accepts, discards or refines it (refine starts again from the sources). On accept the sources count as removed; undo brings them back.
_Avoid_: summarization, auto-compact

**Note**:
Context Block of free text without API role semantics, keeping a reference to its origin: a moved Tool Pair, a Compaction result, the session environment (working directory, OS and shell, date, branch; refreshed by the harness when it changes), project instructions or a file.

**Thinking**:
Context Block holding the model's reasoning for one answer, placed before that answer. Stays in the Context until the user removes it; the model's chat template may still drop it from the rendered request.
_Avoid_: reasoning, chain of thought

**Pin**:
Marker that keeps a Context Block at the top (after System and Tools Block) or the very end of the Context, countering lost-in-the-middle. Pinned blocks keep their order among themselves.

**Kind Filter**:
View restriction at the Review Gate to Context Blocks of one Kind. Changes nothing about the Context and is not recorded in the Session Log.
_Avoid_: search, hide

**Model Profile**:
Per-model settings: backend, endpoint, tokenizer, window size, Tool Protocol, tool result format, sampling, thinking at session start (off, on or effort level; switched at the Gate with `t`), and optionally another Model Profile used for Compaction (default: the same). Fixed for a session; only when it is gone from the config at resume does the session fall back to the default Model Profile.

**Tool Protocol**:
How tool definitions and tool calls travel between harness and model: `native` (API tool calling) or `text-xml` (defined in the prompt). Blocks are stored protocol-neutral; the protocol only affects rendering of a request.
