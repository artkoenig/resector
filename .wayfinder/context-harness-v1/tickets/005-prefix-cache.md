---
id: 005
title: Prefix-/KV-Cache-Verhalten lokaler Backends
labels: [wayfinder:research]
parent: context-harness-v1
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Wie funktioniert Prompt-/Prefix-Caching in llama.cpp-server, Ollama, LM Studio (Slots, cache_prompt, Granularität), und wie kann der Harness vorab berechnen, wie viele Cache-Tokens eine Context-Änderung invalidiert?

## Research

Findings: branch `research/prefix-cache`, file `research/prefix-cache.md`

## Resolution

- llama.cpp: token-level longest common prefix (`cache_prompt` on by default). Every change invalidates everything from the first changed token to the end. `--cache-reuse` (off by default) only helps with deletions, not reorders.
- Ollama (GGUF) now runs llama-server internally: same behaviour, 1 slot, changing `num_ctx` reloads the model and drops the cache. LM Studio: 4 parallel slots by default; MLX engine caches in 256-token blocks.
- Cached tokens are reported: llama.cpp `timings.cache_n` / `cached_tokens`, Ollama `prompt_eval_cached_count`, LM Studio only on `/v1/responses`.
- Prediction: diff the rendered+tokenized prompt against the last sent prompt → first difference = invalidation point. Only approximate for SWA/recurrent models (checkpoints) and templates that rewrite earlier turns.
- Cost for 16k tokens on a 7B model: ~150 s on M1, ~20 s on M4 Max, ~7 s on RTX 3060, ~1 s on RTX 4090; 32B is 4–5× slower.
- Recommendation: one pinned `id_slot` per session, `--cache-reuse` off. Gate shows "cold from block X: N tokens ≈ N/(measured prompt tok/s) s". Compare against reported cached tokens after each response.
