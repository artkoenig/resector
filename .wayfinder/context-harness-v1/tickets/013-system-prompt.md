---
id: 013
title: System-Prompt-Design für kleine Modelle
labels: [wayfinder:grilling]
parent: context-harness-v1
status: open
assignee:
blocked_by: []
---

## Question

Wie lang und was steht im System-Block für 7B–30B-Modelle mit 8k–32k Fenster (Rolle, Tool-Regeln, Konventionen)? Pro Model Profile oder global, mitgeliefert vs. vom User?

Aus [Default-Kürzung](012-tool-output-truncation.md): Harness kürzt nie – der Prompt soll sparsame Tool-Nutzung anregen (read mit Zeilenbereich, grep-Filter, bash-Output begrenzen z. B. `| tail`).
