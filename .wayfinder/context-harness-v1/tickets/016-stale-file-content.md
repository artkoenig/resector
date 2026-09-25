---
id: 016
title: Veraltete Datei-Inhalte im Context
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wie erkennt und markiert das Gate, dass ein Tool Result/@file-Inhalt nicht mehr dem aktuellen Dateistand entspricht (nach edit oder externer Änderung)? Nur markieren, oder Aktualisieren anbieten?

## Resolution

Keine Staleness-Prüfung. Alles im Context ist Snapshot.

- `@file <Pfad>[:a-b]` ist nur bis zum Senden eine Referenz; `e` darauf öffnet die Datei selbst in `$EDITOR`.
- Beim Senden: Datei (bzw. Zeilenbereich) einlesen → Note mit Herkunft `@file <Pfad>`. Session Log speichert den Inhalt wie gesendet.
- Danach keine Verbindung zur Datei: kein Tracking, kein Markieren, kein Aktualisieren. `e` bearbeitet die Note wie jeden Block. Zeilenverschiebungen werden nicht verfolgt.
- Tool Results ebenso Snapshots, nicht geprüft.
- Datei fehlt beim Senden (gelöscht zwischen `@file` und Enter): Senden bricht ab mit „file not found: <Pfad>“.
