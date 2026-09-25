# Resector

Coding agent harness for local LLMs with small context windows. The user sees, measures and edits everything sent to the model.

## Language

**Context Block**:
Smallest addressable unit of what is sent to the model (system prompt, user message, assistant reply, tool call, tool result, pinned file, note). Has a token count; can be edited, moved, removed, compacted.
_Avoid_: message, chunk, segment

**Context**:
The ordered list of Context Blocks sent in the next request.
_Avoid_: prompt, history, window

**Session Log**:
Complete, append-only record of everything that happened in a session, including Context Blocks later removed or compacted. Compaction never destroys Session Log entries.
_Avoid_: history, transcript

**Review Gate**:
Pause before every request to the model (including follow-up requests inside a tool loop) where the user inspects the Context and sends, edits, or compacts it.
_Avoid_: breakpoint, approval

**Compaction**:
User-controlled rewrite of selected Context Blocks by the LLM into fewer tokens.
_Avoid_: summarization, auto-compact

**Note**:
Context Block of free text without API role semantics; e.g. a moved or edited tool result, keeping a reference to its origin.

**Pin**:
Marker that keeps a Context Block at the top or bottom of the Context, countering lost-in-the-middle.

**Model Profile**:
Per-model settings: endpoint, tokenizer, window size, Tool Protocol.

**Tool Protocol**:
How tool definitions and tool calls travel between harness and model: `native` (API tool calling), `text-json` or `text-xml` (defined in the prompt).
