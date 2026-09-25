---
id: 017
title: Teststrategie und Distribution
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wie wird getestet (Session-Log-Replays, Fake-Backend, TUI-Snapshots) und wie wird ausgeliefert (Bun-Binary, npm, Homebrew)?

## Resolution

**Tests**
- Schwerpunkt Core-Unit-Tests (`bun test`): Fold, Rendering pro Tool Protocol (`native`, `text-xml`), Cache-Invalidierungsberechnung, Token-Zählung, Tool-Call-Parsing. UI dünn.
- Golden Tests: Session-Log-Fixtures (JSONL) → Context-Snapshot + gerenderter Request-Payload. Fixtures aus echten Sessions (`resector --export-fixture`).
- Fake-Backend: Bun-HTTP-Server, OpenAI-kompatibel, skriptbar (Streaming, Tool Calls, kaputte Calls, cut off) für Tool-Loop-Integrationstests inkl. Esc-Abbruch und `max_tokens`.
- TUI: wenige Text-Frame-Snapshots via OpenTUI-Test-Renderer (Gate, Compaction-Diff, `/sessions`, Budget-Overflow). Keine Pixel-/E2E-Skripte.
- Live-Suite `bun test:live` (opt-in) gegen lokales llama.cpp mit kleinem Modell: Token-Drift, Cache-Verhalten, Chat-Templates. Nicht in CI; manuell vor Release.
- CI: GitHub Actions, macOS + Linux. Kein Windows in v1.

**Distribution**
- `bun build --compile` Single-Binary: darwin-arm64/x64, linux-x64/arm64 → GitHub Releases + Homebrew-Tap. npm später.
- Risiko: OpenTUI-Native-Lib im kompilierten Binary (opencode macht es vor).
- Kein Auto-Update; `resector --version`, Update via `brew upgrade`.
- Lizenz MIT; Repo wird zum v1-Release öffentlich.
