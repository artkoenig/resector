---
id: 003
title: Tool-Protokolle anderer Agents & lokale Modelle
labels: [wayfinder:research]
parent: context-harness-v1
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Wie realisieren Aider, Cline/Roo, opencode, Continue, Codex Tool-Calls (nativ vs. text-basiert JSON/XML), und wie zuverlässig ist natives Tool-Calling lokaler Modelle (Qwen3-Coder, Devstral, gpt-oss, Llama) über llama.cpp/Ollama? Welche Modelle bevorzugen welches Format?

## Research

Findings: branch `research/tool-protocols`, file `research/tool-protocols.md`

## Resolution

- Agents: Roo (XML dropped Jan 2026), Cline (default native), opencode and Codex are native only. Continue keeps a text fallback. Aider uses text edit formats only. All configure per model; opencode feeds parse errors back to the model; Roo locks the protocol per task.
- Trained formats: XML (`<function=…><parameter=…>`) for Qwen3-Coder, Qwen3.5, GLM. Hermes JSON for Qwen3/2.5. `[TOOL_CALLS]` JSON for Devstral. Harmony for gpt-oss. `<|python_tag|>` JSON for Llama 3.x.
- Native via llama.cpp/Ollama: parser per model family, grammar-constrained. New releases often bring bugs (dropped calls, wrong format, double escaping). LM Studio returns unparseable calls as text.
- Evidence: BFCL local Qwen3 native +0–8 points (mostly multi-turn). Text format alone moves small-model accuracy by 14–81 points. Aider: code inside JSON hurts quality.
- Recommendation: Tool Protocol per Model Profile, default `native`. `text-xml` = Qwen3-Coder syntax, `text-json` = Hermes syntax (mirror trained formats, don't invent new ones). Resector parses itself → malformed calls visible at the Review Gate. Lock the protocol per session.
- Open: does llama.cpp `/apply-template` accept `tools`? (ticket 002 says yes, unverified here)
