---
id: 009
title: Review-Gate-UI im opencode-Stil
labels: [wayfinder:prototype]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wie sieht der Hauptbildschirm aus: Chat + Context-Ansicht (Block-Liste mit Tokens, Budget-Balken, Cache-Invalidierung), und wie fühlt sich das Gate mit Enter/e/c, Reorder und Pin an?

## Prototype

Branch `prototype/review-gate-ui` (Stand siehe Branch-HEAD), `prototypes/review-gate-ui.prototype.mjs` – Node-TUI ohne Deps. Runde 1: A Split/opencode, B Gate-Vollbild + separater Chat, C Prompt-Dokument → B. Runde 2: Chat als eigener Screen nötig? D Gate + Eingabe, E Gate-Chat-Hybrid → D. Start: `node prototypes/review-gate-ui.prototype.mjs D`.

## Resolution

Gewählt: **Variante D – ein einziger Screen**: Gate-Tabelle ist zugleich Chat-Verlauf; kein separater Chat-Screen.

- Kopf (einzige Zeile über der Tabelle): Modell · Backend · Tool Protocol · `GATE` · Tokens gesamt / Fenster (Reserve) · Cache-Kurzinfo „○ kalt ab #N: X ≈ Ys“. **Kein** Budget-Balken, **keine** Summenzeile je Block-Art.
- **UI-Sprache Englisch** (alle Labels, Meldungen, Hilfezeilen).
- Tabelle: `# · Kind · Title · Tokens · Cache ●/○ · Flags (✎n ⤒ ⤓ ⇄ ◇)`, Markierung `●`. Kind ausgeschrieben (System, Tools, User, Assistant, Tool Call, Tool Result, Note), keine Abkürzungen.
- **Verlauf immer sichtbar** (keine Umschaltung): entfernte/umgewandelte Blocks als durchgestrichene, nicht nummerierte Zeilen an ursprünglicher Position mit Grund („entfernt“, „⇄ in Note #n“, „◇ in Compaction“).
- Darunter: Vorschau des gewählten Blocks (Art, Herkunft, Revision, Inhalt).
- Unten: Eingabefeld + Statuszeile (Meldungen, Drift nach Senden, Bestätigungen).
- Streaming: Antwort erscheint live als neue Zeile (Spinner in Token-Spalte), Vorschau folgt; danach automatisch wieder Gate.
- **Eingabefeld immer fokussiert** (opencode-Stil): Tippen landet immer in der Eingabe. `Enter` mit Text = User-Block anlegen + senden (ein Schritt; Context ist sichtbar, Gate bleibt gewahrt). `Enter` bei leerer Eingabe = Context unverändert senden (Tool-Loop). `Esc` leert Eingabe.
- Block-Aktionen über Ctrl (zuverlässig in allen Terminals): `↑↓` wählen, `Ctrl+↑`/`Ctrl+↓` verschieben, `Ctrl+E` `$EDITOR`, `Ctrl+D` entfernen, `Ctrl+P` Pin top→bottom→aus, `Ctrl+Space` markieren, `Ctrl+K` Compaction, `Ctrl+Z` undo, `Ctrl+C` beenden.
- Tool Pair verschieben/pinnen: Hinweis + gleiche Taste nochmal = bestätigen (→ Note).
- Über Budget: Senden blockiert mit Hinweis (Details: Budget-Überschreitung am Gate).
