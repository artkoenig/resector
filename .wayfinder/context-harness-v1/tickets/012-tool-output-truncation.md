---
id: 012
title: Default-Kürzung großer Tool-Outputs
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wie werden große Tool Results begrenzt, bevor sie in den Context gehen (Limit pro Tool, Truncation vs. Paging, Hinweis an Modell, voller Output abrufbar)? Beispiel: bash-Output von 11k Tokens bei 8k Fenster.

## Resolution

Keine automatische Kürzung – weder im Context noch in der Anzeige. Der User kürzt selbst per Editieren.

- Gate-Vorschau zeigt Tool Results vollständig (scrollbar).
- Output größer als Rest-Fenster → normale Blockade aus [Budget-Überschreitung](011-budget-overflow.md) (rot „over by X“). Auflösung durch User: `e` (selbst kürzen), `d` (entfernen), `c` (kompaktieren – nur wenn Block ins Fenster des Compaction-Profils passt, sonst ebenfalls blockiert).
- Entfällt: Limit in Config, Truncation-Marker, Output-Dateien, Paging, `✂`-Flag.
- Sparsame Tool-Nutzung (Zeilenbereiche, Filter, `| tail`) wird über den System-Prompt angeregt → [System-Prompt-Design](013-system-prompt.md).
