---
id: 019
title: Freigabe von Tool Calls vor Ausführung
labels: [wayfinder:grilling]
parent: context-harness-v1
status: open
assignee:
blocked_by: []
---

## Question

Muss ein bash-Call vor Ausführung bestätigt werden (immer / nie / regelbasiert per Muster wie opencode `permission.bash`), wie sieht die Abfrage im Gate aus (einmal / immer für Session / ablehnen mit Begründung), und braucht v1 Sandboxing? Das Review Gate sitzt vor dem Request, nicht vor der Ausführung.

## Referenz: opencode (Code geprüft, sst/opencode@16c56fe, 2026-09-24)

- `permission/index.ts`: Regeln `{permission, pattern, action: allow|ask|deny}`; `evaluate` = **letzte passende Regel gewinnt** (`findLast`, Wildcard), keine passt → `ask`. User-Config wird nach den Defaults angehängt.
- Defaults (`agent/agent.ts`): `"*": allow`; `doom_loop: ask`; `external_directory: ask` (außer Whitelist); `read` von `*.env*`: ask.
- bash (`tool/shell.ts`): Befehl per tree-sitter in Einzelkommandos zerlegt, jedes einzeln geprüft. „Always“ merkt Präfix per Arity-Tabelle + ` *` (z. B. `git checkout *`). Pfade außerhalb des Projekts → zusätzlich `external_directory`.
- Antworten: `once` / `always` (in-memory, nicht persistiert) / `reject` optional mit Nachricht → geht als Feedback ans Modell; reject lehnt alle offenen Anfragen der Session ab.
- Kein Sandboxing.
