---
id: 001
title: opencode-Architektur & TUI-Stack-Optionen
labels: [wayfinder:research]
parent: context-harness-v1
status: closed
assignee: research-agent
blocked_by: []
---

## Question

Welchen Stack nutzt opencode heute (TUI-Lib, Sprache, Agent-Loop), und ließe sich ein Review Gate dort per Plugin/Fork einhängen? Vergleich der TUI-Frameworks (Go/Bubble Tea, TS/OpenTUI/Ink, Rust/ratatui, Python/Textual) nach Reife, $EDITOR-Integration, Rendering langer Listen, Distribution als Single Binary.

## Research

Findings: branch `research/opencode-and-tui-stacks`, file `research/opencode-and-tui-stacks.md`

## Resolution

- opencode today: TypeScript/Bun, TUI on OpenTUI + SolidJS, Vercel AI SDK, client/server, single binary via `bun --compile`. Repo moved to anomalyco/opencode.
- Plugins: `experimental.chat.messages.transform` runs before every request (tool loop included) and can block. But it never sees the final request, has no token counts and no TUI dialog, and is experimental → a plugin is not enough. A fork would be expensive to keep in sync.
- TUI: Bubble Tea v2 or OpenTUI are the top candidates ($EDITOR built in, single binary). Textual is weak on distribution, ratatui needs manual $EDITOR handling, Ink is not recommended.
- Recommendation: build our own harness. Decide Go+Bubble Tea v2 vs TS+OpenTUI with a small prototype (gate list + $EDITOR round-trip).
