# Resector

Coding agent harness for local LLMs with small context windows. The user sees, measures and edits everything sent to the model.

## Language

**Context Block**:
Smallest addressable unit of what is sent to the model. Kinds: System, Tools, User, Assistant, Tool Call, Tool Result, Note. Has a stable identity across Revisions and a token count (rendered, including role markers); can be edited, moved, pinned, removed, restored, compacted.
_Avoid_: message, chunk, segment

**Revision**:
One version of a Context Block's content. Editing creates a new Revision; earlier Revisions stay in the Session Log and can be restored.

**Tools Block**:
Context Block holding the tool definitions offered to the model. Always first after System; tools are switched on/off per session, not edited freely.

**Tool Pair**:
A Tool Call together with its Tool Result. Removed or compacted only as a whole; moving it turns the pair into a single Note.

**Context**:
The ordered list of Context Blocks sent in the next request.
_Avoid_: prompt, history, window

**Session Log**:
Complete, append-only sequence of events of a session: blocks added (by user, model or tool) and Context operations (edit, move, pin, unpin, remove, restore, compact, toggle tool). The Context is derived by replaying it; undo is a counter-event. Nothing is ever deleted.
_Avoid_: history, transcript

**Review Gate**:
Pause before every request to the model (including follow-up requests inside a tool loop) where the user inspects the Context and sends, edits, or compacts it.
_Avoid_: breakpoint, approval

**Compaction**:
User-controlled rewrite of selected Context Blocks by the LLM into one Note at the position of the first source; the sources count as removed. Restoring the Note undoes the Compaction.
_Avoid_: summarization, auto-compact

**Note**:
Context Block of free text without API role semantics, keeping a reference to its origin: a moved Tool Pair, a Compaction result, a file or free text added by the user.

**Pin**:
Marker that keeps a Context Block at the top (after System and Tools Block) or the very end of the Context, countering lost-in-the-middle. Pinned blocks keep their order among themselves.

**Model Profile**:
Per-model settings: endpoint, tokenizer, window size, Tool Protocol.

**Tool Protocol**:
How tool definitions and tool calls travel between harness and model: `native` (API tool calling), `text-json` or `text-xml` (defined in the prompt).
