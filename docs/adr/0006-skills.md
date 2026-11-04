# Skills are loaded on demand

We support **Skills** as used by Claude and other coding agents: a `SKILL.md` folder the model loads on demand.

Skills live in the project's `.claude/skills/` and the user's `~/.claude/skills/` (global). On a name clash the
project's skill wins. They are read once when a Session opens, from the checkout's top level; resector never writes
them (ADR 0004).

The model sees only each skill's metadata (name and description) in a **Skills note** in the Context at session
start (origin `skill`). To use a skill it calls the `skill` tool with the skill's name; the tool reads the SKILL.md
and adds its body to the Context as a Note (origin `skill`, `file` set to the SKILL.md path). The `skill` tool is
always allowed, like `search` — loading a skill needs no approval.

A resumed Session reads them again, since the files may have changed: when they no longer match its last Skills note it
gets a new one at the end of the Context, which keeps the cached prefix. The Tools Block is left alone, so a Session
from before skills needs `/tools` to offer the `skill` tool.

The user can load a skill too, with `/skill <name>`. A skill's frontmatter may declare `requires`: those skills load
with it, directly or not, each once, as Notes of their own; missing ones are ignored. The other `.md` files of a
skill's folder are part of it and appended to its Note, so the model needs no further call to read them.

Skills are markdown data, not executable code, so keeping them in the project is acceptable (unlike Context
Policies, ADR 0001).
