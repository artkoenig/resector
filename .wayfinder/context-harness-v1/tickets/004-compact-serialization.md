---
id: 004
title: Token-effiziente Serialisierung für Tool-Schemas & -Results
labels: [wayfinder:research]
parent: context-harness-v1
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Wie viele Tokens sparen TOON, YAML, Markdown-Tabellen gegenüber JSON für Tool-Beschreibungen und typische Tool-Results (grep, Dateilisten, Diffs), und wie wirkt sich das auf Verständnis/Fehlerquote kleiner Modelle aus (Benchmarks, Erfahrungsberichte)?

## Research

Findings: branch `research/compact-serialization`, file `research/compact-serialization.md`

## Resolution

- Tool schemas (Qwen3 tokenizer, vs. pretty JSON): TOON −41 %, minified JSON −46 %, Markdown −53 %, compact signatures −66 %.
- Tool results: tabular data TOON/CSV/raw text −37 to −52 %. Raw unified diff is the smallest diff format. `rg --heading` saves −59 %.
- Reading: TOON/YAML/Markdown are about as accurate as JSON (within confidence intervals). CSV degrades on large tables. No study of ≤8B models reading TOON.
- Generating: small models fail at writing TOON (Gemma 3 4B structural correctness 0.78→0.05). Tool calls in TOON cost more tokens overall because of retries.
- Recommendation: model output (tool calls) stays JSON. Tool results use the tool's native text (`rg --heading`, raw diff); TOON-style tables for uniform rows. Text protocols describe tools as compact signatures. Result format is a per-Model-Profile setting.
