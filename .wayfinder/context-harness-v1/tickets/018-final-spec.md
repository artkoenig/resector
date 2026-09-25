---
id: 018
title: Finale v1-Spec zusammenführen
labels: [wayfinder:task]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: [012, 013, 014, 015, 016, 017, 019]
---

## Question

Alle Entscheidungen der Map zu PRD + Architektur + Glossar für v1 zusammenführen; Widersprüche auflösen.

## Resolution

Spec geschrieben (Englisch, wie Code/UI/Glossar):

- PRD: [docs/spec/v1-prd.md](../../../docs/spec/v1-prd.md) – FR-1…FR-45, NFR-1…5, Out of scope, Tabelle aufgelöster Widersprüche.
- Architektur: [docs/spec/v1-architecture.md](../../../docs/spec/v1-architecture.md) – Module (Core/Adapters/UI), Session-Log-Events, Request-Pipeline, Rendering, Token-Zählung, Cache, Tool Approval, Config, Tests, Distribution, Risiken.
- Glossar: [CONTEXT.md](../../../CONTEXT.md) (unverändert).

Aufgelöste Widersprüche (spätere/spezifischere Entscheidung gewinnt): Tool Call nur vor Freigabe editierbar; Flags `⤒ ⤓ ⇄ ✎n` statt `📌 ◇`; `Enter` sendet (Details in Vorschau); Protokoll pro Request, nicht pro Session; entfernte Blocks durchgestrichen bis Senden; `n` = ablehnen nur auf `? approve`-Zeile, sonst Note; AGENTS.md einmal bei Session-Anlage gelesen (Snapshot); nur Tool `bash`.

Kleine Ergänzungen beim Zusammenführen: `deny` → Result „denied by rule“; Config-Key `bash.timeout`; `AGENTS.md` vor `CLAUDE.md`.
