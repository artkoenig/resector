---
id: 014
title: Konfiguration: Dateiformat, Ort, Inhalte
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Wo und in welchem Format liegen Model Profiles, Keybindings, Default-Anweisung für Compaction, Tool-Output-Limits (global vs. pro Projekt)? Was ist zur Laufzeit änderbar?

## Resolution

- **Format:** JSONC mit `$schema` (Editor-Completion), wie opencode.
- **Ort/Schichtung:** global `~/.config/resector/config.jsonc`, Projekt `.resector/config.jsonc`; deep merge, Projekt gewinnt; `RESECTOR_CONFIG` überschreibt Pfad. Ob Projekt-Config Freigaben lockern darf → [Tool-Call-Freigabe](019-tool-call-permission.md).
- **Lange Texte als Dateien** neben der Config: `system.md` (System-Prompt), `compaction.md` (Default-Anweisung); pro Model Profile optional Pfad (`systemPrompt: "./prompts/qwen.md"`).
- **Inhalte v1:** `profiles` (Felder aus [Tool Protocol & Model Profile](007-tool-protocol-model-profile.md) + `compactionProfile`, `systemPrompt`), `defaultProfile`, `permission` (Inhalt → 019), `keybindings` (Aktion → Taste). Kein Theme, keine Tool-Liste (nur bash). Tool-Output-Limits entfallen ([012](012-tool-output-truncation.md)).
- **Laufzeit:** Profilwechsel, Tool-Toggle, System-Block-Edit über UI → Events im Session Log, **nie** in Config zurückgeschrieben. Config beim Start gelesen, `/reload` manuell, kein Hot-Reload.
- **Profile anlegen:** minimal `backend` + `endpoint` + `model`; `window`/`tokenizer` automatisch. Erststart ohne Config: Standard-Ports scannen (llama.cpp 8080, Ollama 11434, LM Studio 1234), gefundene Modelle anbieten, Auswahl in globale Config schreiben.
