---
id: 006
title: Tech-Stack festlegen
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: [001]
---

## Question

Welche Sprache und welches TUI-Framework nutzt Resector v1?

## Resolution

- TypeScript on Bun, TUI with OpenTUI + SolidJS (same stack as opencode → its TUI code serves as a reference).
- Reasons: LM Studio SDK exists for JS (exact token counts), tokenizer/GGUF libs (`@huggingface/transformers`, `@huggingface/gguf`), the prototype is already JS, and Solid's fine-grained reactivity suits long block lists and streaming.
- One process: TUI and agent loop together, with a strict module boundary between core and UI. Client/server stays possible later.
- No spike. Known risk: OpenTUI is pre-1.0 and needs Bun. If it blocks us, fall back to Go + Bubble Tea v2 (ticket 001).
