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
- UX-Vorbild: opencode. UI-Sprache: Englisch.
- Beim Charting festgelegt:
  - Coding-Agent, v1 nur Tool `bash` (siehe Decisions: System-Prompt). Neu bauen, opencode als UX-Vorbild.
  - Backends über OpenAI-kompatible API (llama.cpp, Ollama, LM Studio); exakte Token-Zählung per Modell-Tokenizer.
  - Review Gate vor **jedem** Request, auch im Tool-Loop. `Enter` senden, `e` editieren, `c` kompaktieren.
  - Manuelles Editieren: einzelner Block in `$EDITOR`; Reorder/Delete/Pin in der TUI-Liste.
  - Compaction: gleiches Modell (optional separates), User wählt Blocks + Anweisung, **Diff vor Freigabe** (Tokens vorher/nachher).
  - Gegen Lost-in-the-Middle: manuelles Verschieben + Pin top/bottom.
  - Gate zeigt an, wie viele Prefix-Cache-Tokens eine Änderung invalidiert (Info, kein Verbot).
  - Session Log als JSONL auf Platte; Context = abgeleiteter Zustand + Edit-Operationen.
  - Tool Protocol pro Model Profile wählbar – siehe Decisions.

## Decisions so far

<!-- one line per closed ticket -->

- [opencode-Architektur & TUI-Stack-Optionen](tickets/001-opencode-and-tui-stacks.md): eigener Harness statt Plugin/Fork; Stack-Finalisten Go+Bubble Tea v2 vs. TS+OpenTUI
- [Exakte Token-Zählung bei lokalen Backends](tickets/002-token-counting.md): Server-Template rendern + Modell-Vocab tokenisieren; llama.cpp exakt, Ollama/LM Studio mit Workarounds; Drift-Anzeige nach jedem Request
- [Prefix-/KV-Cache-Verhalten lokaler Backends](tickets/005-prefix-cache.md): Cache = gemeinsamer Token-Präfix; Invalidierung ab erster Änderung exakt vorhersagbar, Gate zeigt Tokens + geschätzte Sekunden
- [Token-effiziente Serialisierung für Tool-Schemas & -Results](tickets/004-compact-serialization.md): Tool-Calls in JSON; Results als natives Tool-Textformat bzw. TOON-Tabellen; Schemas als kompakte Signaturen (−66 %)
- [Tool-Protokolle anderer Agents & lokale Modelle](tickets/003-tool-protocols.md): Default `native`; `text-xml`/`text-json` spiegeln trainierte Formate (Qwen3-Coder-XML, Hermes-JSON); Protokoll pro Session fixiert
- [Context-Block-Domänenmodell](tickets/008-context-block-model.md): 7 Block-Arten inkl. Tools Block; Session Log als Event-Folge, Context = Fold; Tool Pair wird beim Verschieben zur Note; Revisionen, Restore, Pin bottom = ganz am Ende
- [Compaction-Flow mit Diff](tickets/010-compaction-flow.md): Vorschlag inline im Gate, nur Auswahl + Anweisung (Default als Hint), zu groß = blockieren, Refine ab Quellen; optionales `compactionProfile`; Flags = Änderungen seit letztem Request
- [Budget-Überschreitung am Gate](tickets/011-budget-overflow.md): keine Antwort-Reserve, `max_tokens` = Rest; blockiert nur ab vollem Fenster; gelb ab 90 %, rot „over by X“; Drift-Abzug bei ungenauem Tokenizer; „⚠ cut off“ statt Auto-Continue
- [Default-Kürzung großer Tool-Outputs](tickets/012-tool-output-truncation.md): keine Kürzung, auch nicht in Anzeige; User kürzt per `e`; zu groß = normale Budget-Blockade; Sparsamkeit via System-Prompt
- [System-Prompt-Design für kleine Modelle](tickets/013-system-prompt.md): v1 nur `bash`; Default ≤400 Tokens, englisch, extrem knapp, bash-Konventionen; Umgebung als eigene Note (Pin top, bei Änderung neu); AGENTS.md als Note
- [Konfiguration: Dateiformat, Ort, Inhalte](tickets/014-configuration.md): JSONC global + Projekt (deep merge); Prompts als .md-Dateien; UI-Änderungen nur ins Session Log; `/reload`; Erststart scannt Backend-Ports
- [Session-Verwaltung: Fortsetzen und Forken](tickets/015-session-management.md): kein Forken; global gespeichert, `resector -c [id]`; `/sessions` als Vollbild-Tabelle mit Preview (umbenennen, löschen); Titel = erste User-Nachricht; fehlendes Profil → Default; Lock pro Session
- [Veraltete Datei-Inhalte im Context](tickets/016-stale-file-content.md): keine Staleness-Prüfung; `@file` nur bis zum Senden Referenz (`e` öffnet Datei), dann Snapshot-Note; fehlt Datei beim Senden = Abbruch
- [Teststrategie und Distribution](tickets/017-testing-distribution.md): Core-Unit- + Golden-Tests aus Session-Log-Fixtures, skriptbares Fake-Backend, wenige TUI-Frame-Snapshots, Live-Suite opt-in; Gates: CRAP ≤ 8, Mutation 100 % (Core), dependency-cruiser; CI macOS+Linux; Bun-Binaries via GitHub Releases + Homebrew; MIT, öffentlich ab v1
- [Review-Gate-UI im opencode-Stil](tickets/009-review-gate-ui.md): ein Screen – Gate-Tabelle ist Chat-Verlauf (entfernte Blocks durchgestrichen sichtbar), Vorschau, Eingabe unten, Streaming inline; kein Budget-Balken/Summenzeile, Cache-Kurzinfo im Kopf
- [Tech-Stack festlegen](tickets/006-tech-stack.md): TS/Bun + OpenTUI + SolidJS, ein Prozess mit Core/UI-Modulgrenze; Risiko OpenTUI pre-1.0
- [Tool Protocol & Model Profile](tickets/007-tool-protocol-model-profile.md): v1 `native` + `text-xml`; Blocks protokollneutral, Rendering pro Request; verschobenes Tool Pair = Klartext-Note; kaputte Calls ⚠ am Gate; Profilwechsel in Session erlaubt; llama.cpp braucht `--jinja`

## Not yet specified

<!-- alles bisherige in Tickets 012–018 überführt -->

## Out of scope

- Automatische Platzierungsregeln / Auto-Compaction (v1 bleibt manuell + kontrolliert).
- MCP, LSP, Web-Tools.
- Cloud-Provider-Optimierung (nur OpenAI-kompatible lokale Backends im Fokus).
