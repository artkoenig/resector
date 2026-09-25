---
id: 013
title: System-Prompt-Design für kleine Modelle
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wie lang und was steht im System-Block für 7B–30B-Modelle mit 8k–32k Fenster (Rolle, Tool-Regeln, Konventionen)? Pro Model Profile oder global, mitgeliefert vs. vom User?

Aus [Default-Kürzung](012-tool-output-truncation.md): Harness kürzt nie – der Prompt soll sparsame Tool-Nutzung anregen (read mit Zeilenbereich, grep-Filter, bash-Output begrenzen z. B. `| tail`).

## Resolution

- **Tools v1: nur `bash`** (lesen, schreiben, suchen). Ersetzt read/edit/grep/glob aus dem Charting. Tools Block = eine kompakte Signatur.
- **System-Prompt-Default ≤ ~400 Tokens**, Englisch, mitgeliefert. Inhalt:
  - Rolle: lokaler Coding-Agent.
  - Output-Stil: „Be extremely concise. Sacrifice grammar for the sake of concision."
  - bash-Konventionen: lesen per `sed -n 'a,bp'` / `grep -n`; suchen per `grep -rn`/`rg`, `find`/`ls`; Output begrenzen (`| head`/`| tail`); neue Datei per Heredoc; kleine Änderung per `sed -i`; größere nur bei kleinen Dateien per Heredoc komplett. Kein `patch`.
  - Keine Few-Shot-Beispiele.
- **Quelle:** Default, global in Config überschreibbar, optional pro Model Profile.
- **Am Gate editierbar** (`e` → Revision), nur session-lokal, nicht in Config zurück.
- **Umgebung nicht im System-Prompt**, sondern eigene Note (Herkunft `environment`), Pin top. Inhalt: cwd, OS/Shell, Datum (ohne Uhrzeit), git-Branch; kein `git status`. Vor jedem Request neu erzeugt, nur bei Änderung ersetzt (neue Revision, Flag `✎`; Cache-Verlust am Gate sichtbar).
- **Projekt-Instruktionen** (`AGENTS.md`/`CLAUDE.md`): automatisch als eigene Note (Herkunft Datei), Pin top.
- Bestätigung von Tool Calls → neues Ticket [Tool-Call-Freigabe](019-tool-call-permission.md).
