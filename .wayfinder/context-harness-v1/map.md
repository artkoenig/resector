---
title: Resector – Context-Harness v1
labels: [wayfinder:map]
status: open
---

## Destination

Umsetzbare **Spec für v1** (PRD + Architektur + Glossar) eines textbasierten Coding-Agents für lokale LLMs mit kleinem Fenster (8k–32k), dessen Kern ein **Review Gate** vor jedem Request ist: Context sehen, Tokens pro Block messen, manuell editieren/verschieben, per LLM kompaktieren (mit Diff). Map endet, wenn nichts mehr vor der Umsetzung zu entscheiden ist.

## Notes

- Domäne: Glossar in [CONTEXT.md](../../CONTEXT.md) – Begriffe dort verwenden (Context Block, Context, Session Log, Review Gate, Compaction, Model Profile, Tool Protocol, Note, Pin).
- Jede Session: Skills `grilling` + `domain-modeling`; `prototype` für UX-Tickets; `research` für Research.
- Tracker: local-markdown. Ticket = Datei in `tickets/`, Frontmatter `status`, `assignee` (Claim), `blocked_by` (ids). Frontier = open, alle blocker closed, kein assignee.
- UX-Vorbild: opencode.
- Beim Charting festgelegt:
  - Coding-Agent (read mit Zeilenbereich, edit, grep/glob, bash). Neu bauen, opencode als UX-Vorbild.
  - Backends über OpenAI-kompatible API (llama.cpp, Ollama, LM Studio); exakte Token-Zählung per Modell-Tokenizer.
  - Review Gate vor **jedem** Request, auch im Tool-Loop. `Enter` senden, `e` editieren, `c` kompaktieren.
  - Manuelles Editieren: einzelner Block in `$EDITOR`; Reorder/Delete/Pin in der TUI-Liste.
  - Compaction: gleiches Modell (optional separates), User wählt Blocks + Anweisung, **Diff vor Freigabe** (Tokens vorher/nachher).
  - Gegen Lost-in-the-Middle: manuelles Verschieben + Pin top/bottom.
  - Verschobene/editierte Tool-Results werden zu **Notes** (vorbehaltlich Tool-Protocol-Entscheidung).
  - Gate zeigt an, wie viele Prefix-Cache-Tokens eine Änderung invalidiert (Info, kein Verbot).
  - Session Log als JSONL auf Platte; Context = abgeleiteter Zustand + Edit-Operationen.
  - Tool Protocol pro Model Profile wählbar (`native` | `text-json` | `text-xml`) – Details offen.

## Decisions so far

<!-- one line per closed ticket -->

- [opencode-Architektur & TUI-Stack-Optionen](tickets/001-opencode-and-tui-stacks.md): eigener Harness statt Plugin/Fork; Stack-Finalisten Go+Bubble Tea v2 vs. TS+OpenTUI

## Not yet specified

- System-Prompt-Design für kleine Modelle (Länge, Inhalt, selbst als editierbarer Block).
- Default-Kürzung großer Tool-Outputs (Truncation, Paging) bevor sie in den Context gehen.
- Konfiguration: Model Profiles, Keybindings, Dateiformat/Ort.
- Session-Verwaltung: Fortsetzen, Forken, Undo von Context-Edits.
- Datei-Snapshots vs. Live-Datei: veraltete Datei-Inhalte im Context erkennen/markieren.
- Teststrategie & Distribution/Packaging.
- Zusammenführung aller Entscheidungen in das finale Spec-Dokument.

## Out of scope

- Automatische Platzierungsregeln / Auto-Compaction (v1 bleibt manuell + kontrolliert).
- MCP, LSP, Web-Tools.
- Cloud-Provider-Optimierung (nur OpenAI-kompatible lokale Backends im Fokus).
