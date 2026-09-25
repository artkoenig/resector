---
id: 015
title: Session-Verwaltung: Fortsetzen und Forken
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wie werden Sessions gelistet, fortgesetzt und geforkt (ab welchem Punkt im Session Log)? Was passiert beim Fortsetzen mit kaltem Cache und geändertem Model Profile?

## Resolution

- **Kein Forken.** Forken wäre nur Krücke zum Context-Bearbeiten; das Gate kann das direkt.
- **Ablage:** global `~/.local/share/resector/sessions/<project-hash>/<id>.jsonl` (wie opencode), nichts im Repo.
- **Start:** `resector` = neue Session; `resector -c [id]` = letzte bzw. bestimmte fortsetzen. Kein `-s`.
- **`/sessions`:** Vollbild-Tabelle (Prototyp-Variante B), nur Sessions des aktuellen Projekts, neueste zuerst.
  - Spalten: Markierung (● aktuell, ⊘ gesperrt), Titel, Updated, Model Profile (⚠ wenn nicht in Config), Context-Tokens/Fenster (gelb >90 %), Blocks.
  - Darunter Preview: letzte Blocks der markierten Session.
  - Tasten: ↑↓, Enter öffnen, `r` umbenennen, `d` löschen → „Delete …? y / N“, `n` neu, `/` filtern, Esc zurück.
  - Aktuelle Session gelöscht → Wechsel zur neuesten anderen; keine übrig → neue leere Session.
- **Titel:** erste User-Nachricht (gekürzt), kein LLM-Titel; umbenennbar (`r` bzw. `/rename`), leer = zurück zur ersten User-Nachricht.
- **Löschen:** ganze Session-Datei, nach Bestätigung. „Nichts wird gelöscht“ gilt nur innerhalb einer Session.
- **Fortsetzen:** Context = Replay des Session Logs, dann Gate. Kalter Cache nur als Info im Kopf („cold cache: X tok, ~Ys prefill“), kein Vorschlag.
- **Umgebung:** Environment-Note wie immer neu erzeugt, bei Änderung ✎. Geänderte Dateien (AGENTS.md u. a.) → [Veraltete Dateiinhalte](016-stale-file-content.md).
- **Model Profile:** Log speichert nur Profilnamen; Werte aus aktueller Config, Session-Overrides aus dem Log darüber. Profil fehlt → `defaultProfile` + Hinweis am Gate, neu rendern.
- **Sperre:** Lock-Datei pro Session; zweite Instanz verweigert Öffnen und Löschen mit Hinweis.
- **Streaming:** Antwort erst nach Ende ins Log; Abbruch per Esc schreibt Teilantwort mit „⚠ cut off“; Absturz = Antwort verloren, Fortsetzen steht am Gate vor dem Request.
- **Dateisystem:** Fortsetzen stellt keine Dateien wieder her; keine Snapshots in v1.

Prototyp (Varianten A Modal, B Tabelle, C Seitenleiste, D Gate-Ansicht): Branch `prototype/sessions-dialog`, `prototypes/sessions-dialog.prototype.mjs`.
