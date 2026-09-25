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

**Quality Gates** (nach Vorbild Uncle Bob: crap4x, mutate4x, dependency-checker, dry4x)
- CRAP-Score hart ≤ 8 pro Funktion, gesamter Code (Core + UI). Coverage via `bun test --coverage` (LCOV) → `crap-ts --fail-above 8`. Bewusst nicht < 4: laut Bobs `negative-test-experiment` zersplittert das den Code ohne Design-Gewinn.
- Mutation Testing (Core, nicht UI): 0 überlebende + 0 unabgedeckte Mutanten (Stryker-Score 100 % inkl. NoCoverage). Unterdrückung nur per `// Stryker disable next-line <mutator>: <grund>`. Stryker mit Community-Bun-Runner (`@hughescr/stryker-bun-runner`), Fallback Jest-Runner. Risiko: kein offizieller Bun-Runner.
- Architektur: `dependency-cruiser` als Gate – Core importiert nie UI.
- Duplikate: `jscpd` nur Report, kein Gate. Kein Gherkin – Golden Tests übernehmen Akzeptanz-Rolle.
- Wann: PR = alle Gates, Stryker inkrementell; nightly + vor Release komplett. Lokal `bun run gate` (gleiche Checks, kein erzwungener Hook). Alle Gates blockieren Merge.

**Distribution**
- `bun build --compile` Single-Binary: darwin-arm64/x64, linux-x64/arm64 → GitHub Releases + Homebrew-Tap. npm später.
- Risiko: OpenTUI-Native-Lib im kompilierten Binary (opencode macht es vor).
- Kein Auto-Update; `resector --version`, Update via `brew upgrade`.
- Lizenz MIT; Repo wird zum v1-Release öffentlich.
