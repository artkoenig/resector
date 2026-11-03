# Skills are loaded on demand

We support **Skills** as used by Claude and other coding agents: a `SKILL.md` folder the model loads on demand.

Skills live in the project's `.claude/skills/` and the user's `~/.claude/skills/` (global). On a name clash the
project's skill wins. They are read once at session start; resector never writes them (ADR 0004).

The model sees only each skill's metadata (name and description) in a **Skills note** in the Context at session
start (origin `skill`). To use a skill it calls the `skill` tool with the skill's name; the tool reads the SKILL.md
and adds its body to the Context as a Note (origin `skill`, `file` set to the SKILL.md path). The `skill` tool is
always allowed, like `search` — loading a skill needs no approval.

Skills are markdown data, not executable code, so keeping them in the project is acceptable (unlike Context
Policies, ADR 0001).
