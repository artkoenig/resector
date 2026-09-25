---
id: 011
title: Budget-Überschreitung am Gate
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: [002, 008]
---

## Question

Was passiert, wenn der Context am Review Gate das Fenster (minus Antwort-Reserve) überschreitet: Senden blockieren, Vorschläge machen, Blocks markieren? Wie groß ist die Antwort-Reserve?

## Resolution

- **Keine Antwort-Reserve.** Der User kontrolliert den Context voll; Budget = ganzes Fenster. Jeder Request schickt `max_tokens` = Fenster − Context (Rest für die Antwort).
- Senden blockiert nur, wenn Context ≥ Fenster. Sonst immer erlaubt – auch wenn kaum Platz für die Antwort bleibt (Verantwortung beim User).
- Anzeige: Kopfzeile Tokens / Fenster; **gelb ab 90 %**, **rot mit „over by X“** über dem Fenster. Keine Liste größter Blocks, keine Vorschläge, kein Sprung-Key.
- Nicht-exakter Tokenizer (Ollama, LM Studio): zuletzt gemessene Drift wird als Sicherheitsabstand vom Fenster abgezogen, Kopfzeile zeigt „±X“. llama.cpp exakt → kein Abzug.
- Antwort abgeschnitten (`finish_reason=length`): Assistant-Block bekommt „⚠ cut off“, bleibt im Context (entfernbar). Abgeschnittener Tool Call wird nicht ausgeführt. User räumt am Gate auf und sendet neu; kein Auto-Continue.
- Überschreitung im Tool-Loop (z. B. großes Tool Result): gleiches Gate-Verhalten, Loop pausiert. Kürzung großer Tool-Outputs bleibt eigenes Thema.

Folgen für frühere Tickets: [Review-Gate-UI](009-review-gate-ui.md) Kopf ohne „(Reserve)“; [Compaction-Flow](010-compaction-flow.md) Fenster-Check = Prompt + Blocks + Anweisung < Fenster, Antwort bekommt den Rest.
