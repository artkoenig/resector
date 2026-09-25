---
id: 010
title: Compaction-Flow mit Diff
labels: [wayfinder:prototype]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: [009]
---

## Question

Wie läuft Compaction konkret: Blocks auswählen, Anweisung eingeben, Diff (Text + Tokens vorher/nachher) prüfen, annehmen/verwerfen/nachbessern – und was passiert, wenn der Kompaktierungs-Request selbst nicht ins Fenster passt?

## Prototype

Branch `prototype/compaction-flow` (HEAD 2577ae1), `prototypes/compaction-flow.prototype.mjs` – Node-TUI ohne Deps, basiert auf Gate-Variante D. Varianten: A Inline proposal, B Review screen (Vorher | Nachher), C Diff in preview → **A**. Start: `node prototypes/compaction-flow.prototype.mjs A`; `L` simuliert riesiges Tool Result (Überlauf).

## Resolution

Gewählt: **Variante A – Vorschlag inline in der Gate-Tabelle**, kein eigener Screen, kein Diff-Modus.

- Auswahl: `Space` markiert (Tool Pair immer ganz) und springt zum nächsten Block → Dauer-`Space` markiert fortlaufend. Ohne Markierung = aktueller Block (+ Pair).
- `c` → Eingabezeile wird `instruction >`; darüber: „◇ Compact N blocks (X tok) · <Modell> · request Y / Fenster (prompt + blocks + instruction + output)“. Default-Anweisung (Config) nur als **grauer Hint**; leer + `Enter` = Default; `Tab` übernimmt Hint zum Editieren. Keine Presets, kein „letzte Anweisung merken“. Keine Tasten-Hilfezeile im Anweisungsschritt.
- Request-Inhalt: **nur ausgewählte Blocks + Anweisung** (nicht ganzer Context). Folge bei gleichem Modell/Slot: Session-Cache danach kalt – Statuszeile zeigt es.
- Passt der Request nicht ins Fenster: **blockieren** mit Hinweis (Auswahl verkleinern, `d`/`e`). Kein Chunking/Map-Reduce in v1.
- Ergebnis streamt als Zeile „◇ proposal · attempt k“ an Position der ersten Quelle; Quellen durchgestrichen „◇ proposed“; Vorschau zeigt Vorschlagstext; Statuszeile: Tokens vorher → nachher (−%), Context danach / Fenster, Cache-Folge. Kopf-Tag `COMPACTION`.
- Review (Gate gesperrt): `Enter` annehmen, `x`/`Esc` verwerfen, `i` Anweisung ändern (vorbefüllt) → **neuer Lauf ab den Quellen**, nur aktueller Versuch zählt; `e` Vorschlag in `$EDITOR`. `Esc` in Anweisung nach Versuch = zurück zum Review.
- Annehmen: Note `◇ N blocks compacted` (Herkunft: Quellen + Anweisung), Quellen **verschwinden sofort** aus der Tabelle (keine Geisterzeilen); `u` stellt sie wieder her. Gleiches für Tool Pair → Note.
- Compaction-Modell: optional `compactionProfile` im Model Profile (Config, nicht pro Compaction umschaltbar); fehlt es = Session-Modell. Fenster-Check nutzt dessen Fenster.

Nebenbei am Gate (ändert [Review-Gate-UI](009-review-gate-ui.md)):

- **Flags = Änderungen seit dem letzten Request**: `✎n` neue Revision, `⤒`/`⤓` Pin gesetzt/geändert, `⇄` vom User verschoben. Nach Senden alle zurückgesetzt (Pin wirkt weiter). Kein `◇`-Flag (Titel zeigt es).
- Mit `d` entfernte Blocks bleiben durchgestrichen sichtbar **bis zum Senden**, danach weg. Undo bleibt möglich (Session Log vollständig).
