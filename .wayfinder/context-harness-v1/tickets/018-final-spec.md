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

## Prototyp (Primärquelle)

Gesamt-Prototyp auf Branch [`prototype/complete`](https://github.com/artkoenig/resector/tree/prototype/complete): `prototypes/resector.prototype.mjs` (`node prototypes/resector.prototype.mjs`, `--llm URL` für echten Server). Vereint Gate D, Compaction A, `/sessions` B und alle späteren Entscheidungen; echte bash-Ausführung im Demo-Repo.

Frage: Passen die Entscheidungen zusammen? Verdikt – in die Spec übernommen:

- Thinking als eigener Block-Kind, immer mitgeschickt; vom Template verworfen → `✂ template`; Einstellung nur pro Model Profile (FR-46…50).
- `/`-Vorschläge beim Tippen; v1-Befehle nur `/sessions`, `/rename`, `/reload`.
- Gestrichen: freie Note (`n`), Trash-Ansicht (FR-11), Tools an/aus (FR-12), Profilwechsel in der Session (FR-39).
- `Space` markiert ohne Weiterspringen.
- Kopfzeile: Modell · Context-Balken nach Kind gefärbt, ausgewählter Block hervorgehoben · Tokens / Fenster (FR-2).
- Vorschau-Überschrift max. 50 Zeichen mit „...“ (nur Prototyp-Detail).
