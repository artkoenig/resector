---
id: 007
title: Tool Protocol & Model Profile
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: [003, 004, 008]
---

## Question

Wie sieht das Model Profile aus (Felder: Endpoint, Tokenizer, Fenstergröße, Tool Protocol, Serialisierung), welche Tool Protocols unterstützt v1 wirklich, und wie werden Tool Pairs und in Notes umgewandelte Tool Pairs je Protokoll gerendert (Domänenregel steht: Move → Note, siehe Context-Block-Domänenmodell)? Klären: rendert llama.cpp `/apply-template` das `tools`-Feld mit (Widerspruch zwischen Token- und Tool-Protokoll-Research)?

## Resolution

- **v1 protocols:** `native` and `text-xml` (Qwen3-Coder syntax). `text-json` (Hermes) comes later, behind the same interface.
- **Model Profile fields:** `name`, `backend` (`llamacpp`|`ollama`|`lmstudio`), `endpoint`, `model`, `window` (auto from backend, can be overridden), `tokenizer` (auto per backend, override: path), `toolProtocol`, `resultFormat` (`native`|`toon`), `sampling`, and a measured `promptTokPerSec` for the cache cost estimate. A separate compaction model is a reference to another profile in the config.
- **Rendering a Tool Pair:**
  - `native`: Assistant text plus its ToolCalls become one assistant message with `tool_calls`; each ToolResult becomes a `tool` message.
  - `text-xml`: calls are `<function=…><parameter=…>` inside the assistant text; results go in a user message as `<tool_response>…</tool_response>`.
  - Resector serializes; the backend's chat template renders.
- **Note from a moved Tool Pair:** same for every protocol. A plain-text user message with a header line `[Tool bash: npm test]` followed by the result. It never uses tool syntax, so the model doesn't take it for its own current call.
- **Tools Block under `text-xml`:** compact signatures (ticket 004), appended to the system message. At the gate it stays its own block, with tokens computed from the prefix difference. Under `native` it goes in the `tools` field.
- **Malformed tool call:** stays an Assistant block marked ⚠ at the gate and is not executed. The user edits it, removes it, or sends; sending appends an error Note.
- **Storage:** ToolCall blocks are stored protocol-neutral as `{name, args}`, ToolResult blocks as text. Rendering into a protocol happens at request time.
- **Switching profile mid-session is allowed**, including a protocol change. The whole Context is re-rendered with the new protocol and the gate shows "cache fully cold". This refines ticket 003's "one protocol per session": there is only ever one protocol per request.
- **llama.cpp fact (checked on master):** `/apply-template` and `/v1/chat/completions/input_tokens` render `tools` when `--jinja` is on; without it, a request with tools fails. `/tokenize` ignores tools. Resector checks for `--jinja` at startup when the backend is `llamacpp`.
