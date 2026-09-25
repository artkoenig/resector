---
id: 019
title: Freigabe von Tool Calls vor Ausführung
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
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

Aus [Konfiguration](014-configuration.md): Projekt-Config (`.resector/config.jsonc`) überschreibt global per deep merge – darf sie `permission` lockern (Risiko: fremdes Repo)?

## Resolution

- **Regeln** wie opencode: Muster → `allow`/`ask`/`deny`, letzte passende gewinnt. Default `ask`. Vorkonfiguriert `allow` (nur lesend): `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `sed -n`, `git status/diff/log/show`.
- **Ablauf**: erlaubt → sofort ausführen → Gate mit Result → `Enter` sendet. `ask` → Gate zeigt Tool Call mit `? approve`, Senden gesperrt → nach Freigabe ausführen → Gate mit Result. Freigabe sendet nie automatisch mit.
- **Tasten** bei `? approve`: `y` einmal; `a` immer für Session (Präfix + ` *`, z. B. `bun test *`, vor Speichern angezeigt); `n` ablehnen ohne Begründung → Tool Result „rejected by user“ (Begründung ggf. als normale User-Nachricht); `e` Befehl vor Ausführung bearbeiten → neue Revision des Tool Calls, erneute Prüfung.
- **„Immer“** = Event im Session Log, gilt nach Resume weiter, nur diese Session. Dauerhaft nur per Config.
- **Zusammengesetzte Befehle** (`&&`, `;`, `|`, `$(…)`): Parsen mit tree-sitter-bash (wasm), jedes Einzelkommando muss erlaubt sein; unparsebar → `ask`.
- **Projekt-Config** darf nur verschärfen (`ask`/`deny`); `allow` aus Projekt ignoriert + Hinweis am Gate.
- **Pfade außerhalb des Projekts** (absolut, `..`), per Parsing erkannt → `ask`, auch wenn sonst erlaubt (Heuristik).
- **Mehrere Calls** einer Antwort: der Reihe nach einzeln geprüft/freigegeben; `n` betrifft nur diesen Call; Results in Call-Reihenfolge.
- **Kein Doom-Loop-Schutz**, **kein Sandboxing** in v1.
- **Laufzeit**: Timeout 120 s (konfigurierbar); `Esc` bricht laufenden Befehl ab → bisheriger Output + „⚠ killed“, bei Timeout „⚠ timeout“; stdin = `/dev/null`.
- Glossar: **Tool Approval** in CONTEXT.md.
