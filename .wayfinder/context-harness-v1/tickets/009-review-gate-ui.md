---
id: 009
title: Review-Gate-UI im opencode-Stil
labels: [wayfinder:prototype]
parent: context-harness-v1
status: open
assignee: artkoenig
blocked_by: []
---

## Question

Wie sieht der Hauptbildschirm aus: Chat + Context-Ansicht (Block-Liste mit Tokens, Budget-Balken, Cache-Invalidierung), und wie fühlt sich das Gate mit Enter/e/c, Reorder und Pin an?

## Prototype

Branch `prototype/review-gate-ui` (commit 32d61e8), `prototypes/review-gate-ui.prototype.mjs` – Node-TUI ohne Deps, drei Varianten (A Split/opencode, B Gate-Vollbild, C Prompt-Dokument), `<`/`>` wechselt. Start: `node prototypes/review-gate-ui.prototype.mjs B`.

## Resolution (vorläufig, wieder geöffnet)

Gewählt: **Variante B – Gate-Vollbild**. Wieder geöffnet: Braucht es den Chat als eigenen Screen, oder reicht die Gate-Ansicht mit Eingabe unten? → zweiter Prototyp.

- Gate ist ein eigener Vollbild-Modus, erscheint vor jedem Request; Chat (Session Log, entfernte/umgewandelte Blocks ausgegraut) ist separater Screen, `Tab` wechselt.
- Oben: Budget-Balken über ganze Breite (Farbe je Block-Art, `▓` = cache-kalt, `░` = Antwort-Reserve), Summen je Block-Art + Template, Cache-Zeile „kalt ab #N: X tok ≈ Ys, davon invalidiert Z“.
- Mitte: Tabelle `# · Art · Titel · Tokens · Anteil-Balken · Cache ●/○ · Flags (✎n ⤒ ⤓ ⇄ ◇)`, Markierung `●`.
- Unten: Vorschau des gewählten Blocks (Art, Herkunft, Revision, Inhalt).
- Statuszeile: Meldungen (Drift nach Senden, Bestätigungen) bzw. Eingabe.
- Tasten (aus Prototyp übernommen, keine Einwände): `Enter` senden, `↑↓`/`jk` wählen, `J`/`K` verschieben, `p` Pin top→bottom→aus, `d` entfernen, `e` `$EDITOR`, `Space` markieren, `c` Compaction, `u` undo, `i` Eingabe, `Tab` Chat.
- Tool Pair verschieben/pinnen: Hinweis + gleiche Taste nochmal = bestätigen (→ Note).
- Über Budget: Senden blockiert mit Hinweis (Details: Budget-Überschreitung am Gate).
