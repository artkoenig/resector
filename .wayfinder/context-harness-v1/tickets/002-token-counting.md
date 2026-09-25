---
id: 002
title: Exakte Token-Zählung bei lokalen Backends
labels: [wayfinder:research]
parent: context-harness-v1
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Wie zählt man Tokens pro Context Block exakt für llama.cpp-server, Ollama und LM Studio (Tokenize-Endpoints, lokale Tokenizer, Chat-Template-Overhead pro Nachricht/Tool-Schema)? Wie ermittelt man die Kontextgröße des geladenen Modells?

## Research

Findings: branch `research/token-counting`, file `research/token-counting.md`

## Resolution

- Principle: render the full Context with the backend's own chat template and tokenize it with the model vocab; that total is the true number. Split per block via offset mapping or prefix differences; show the rest as a "template overhead" row.
- llama.cpp: exact. `/apply-template` + `/tokenize` (`with_pieces`); `/v1/chat/completions/input_tokens` for the total. `n_ctx` from `/props`/`/slots` is per slot (`--parallel` makes it smaller).
- Ollama: no tokenize endpoint. `_debug_render_only` (undocumented) + local tokenizer on the same GGUF. `context_length` from `/api/ps`. Pitfall: `truncate` defaults to true and silently drops context → use native `/api/chat` with `truncate:false` and `num_ctx`.
- LM Studio: exact counts only via SDK (`applyPromptTemplate`, `countTokens`). Tool overhead only visible in `usage.prompt_tokens` → measure once with `max_tokens:1` and cache it. Context size from `/api/v1/models`.
- Recommendation: tokenizer interface per Model Profile; after each request compare pre-count vs. `usage.prompt_tokens` and show drift in the Review Gate.
- Open: LM Studio slot splitting, stability of Ollama's debug flag, whether LM Studio `applyPromptTemplate` accepts tools.
