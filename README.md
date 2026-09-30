<div align="center">

```
██████╗ ███████╗███████╗███████╗ ██████╗████████╗ ██████╗ ██████╗
██╔══██╗██╔════╝██╔════╝██╔════╝██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗
██████╔╝█████╗  ███████╗█████╗  ██║        ██║   ██║   ██║██████╔╝
██╔══██╗██╔══╝  ╚════██║██╔══╝  ██║        ██║   ██║   ██║██╔══██╗
██║  ██║███████╗███████║███████╗╚██████╗   ██║   ╚██████╔╝██║  ██║
╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝ ╚═════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝
```

**The coding agent for local LLMs that shows you its context.**<br />
See, measure and edit every token before it reaches the model.

<a href="https://github.com/artkoenig/resector/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/artkoenig/resector?style=flat-square" /></a>
<a href="https://github.com/artkoenig/resector/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/artkoenig/resector/ci.yml?branch=main&style=flat-square" /></a>
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>

<br /><br />
<img width="800" alt="resector demo: the tool loop stopped at the Gate, a read Tool Pair removed, two Thinking blocks compacted into a Note (166 → 34 tokens), then the lean-compact policy switched on" src="docs/assets/demo.gif" />

</div>

---

Local models get a few ten thousand tokens, not a million. Agents built for cloud models hide the context in a transcript that grows until something compacts it behind your back — and a 30B model on a laptop falls apart long before that.

resector turns the context into something you work with. It is a list of blocks, each with its token count and prefix-cache state. Every request stops at a **Review Gate** where you remove, edit, move or compact blocks before anything is sent. When you know which rules work, write them down as a **Context Policy** and let resector apply them for you, in the open.

## Features

- **Review Gate:** a pause before every request to the model, including every follow-up inside a tool loop.
- **Token-exact:** each Context Block shows its tokens as rendered, counted with the model's own tokenizer, against the window.
- **Cache-aware:** each block shows whether the server's prefix cache still holds it (`●`) or has to recompute it from there (`○`).
- **Manual Compaction:** mark any blocks and let the model rewrite them into one Note. Review, refine or discard the proposal.
- **Context Policies:** stateless TypeScript functions that edit the Context before each request — with the same operations and rules as you.
- **Nothing is lost:** the Session Log is append-only. Edits create Revisions; removals, moves and Compactions can be undone.
- **Local backends:** llama.cpp, Ollama, LM Studio and oMLX. Native tool calling, or tools in the prompt for models without it.
- **Guarded tools:** `bash` calls are parsed and checked against `allow` / `ask` / `deny` rules; the model can ask you questions instead of guessing.

## Installation

```bash
# Homebrew (macOS and Linux)
brew install artkoenig/tap/resector
```

Or grab a binary for `darwin-arm64`, `darwin-x64`, `linux-x64` or `linux-arm64` from the [releases page](https://github.com/artkoenig/resector/releases).

<details>
<summary><strong>From source</strong></summary>

Requires [Bun](https://bun.sh) ≥ 1.3.7.

```bash
git clone https://github.com/artkoenig/resector.git
cd resector
bun install
scripts/install-dev.sh   # `resector` in ~/.local/bin, running this checkout
```

</details>

## Getting Started

Start a model server, then run resector in your project:

```bash
llama-server -m your-model.gguf --jinja   # or Ollama, LM Studio, oMLX
cd your-project
resector
```

On first start resector looks for model servers on their default ports, lets you pick a model and writes `~/.config/resector/config.jsonc`. Window size and tokenizer are detected.

```bash
resector            # new session
resector -c         # continue the last session
resector -c <id>    # continue a given session
```

## Context Management

Everything the next request sends is the **Context**: an ordered list of **Context Blocks** — System, Tools, User, Thinking, Assistant, Tool Call, Tool Result and Note. Nothing is sent that is not on screen.

### The Review Gate

Before every request resector stops and shows the Context, one row per block with its tokens and cache state.

| Key | Action |
| --- | --- |
| `enter` | send |
| `tab` | type a message (`/` for commands, `@` for files) |
| `e` | edit the selected block (creates a new Revision) |
| `⌥↑` / `⌥↓` | move the selected block |
| `d` | remove the selected or marked blocks |
| `space` / `c` | mark blocks / compact them |
| `u` | undo the last operation |
| `y` / `a` / `n` | pending Tool Call: run once / allow for the session / reject |
| `q` | quit |

A few rules keep the Context valid: the Tools Block stays first and is never edited; a Tool Call and its Tool Result are removed or compacted only as a pair; moving a pair turns it into a Note. `/filter <kind>` hides whole kinds from view (Tool Calls start hidden) without touching what is sent.

### Compaction

Mark the blocks that have served their purpose and press `c`. The model sees only those blocks and an instruction, and writes one **Note** that takes the place of the first. Accept it, discard it, or change the instruction and try again. Undo brings the originals back.

Replace the shipped instruction with a `compaction.md` next to your config; a separate, cheaper model can do the work via `compactionProfile`.

### Notes

A Note is free text without a chat role. resector adds them for the session environment (directory, OS, shell, date, git branch — refreshed when it changes), for `AGENTS.md` / `CLAUDE.md` in the project root, and for files you reference with `@path`. Personal instructions that do not belong in the repository go to `~/.config/resector/projects/<project>/AGENTS.md`.

### The prefix cache

Local servers reuse the prompt up to the first token that changed. Every edit early in the Context makes the server recompute everything after it — on a laptop that can take minutes. The `●` / `○` column shows where that point is *before* you send, so you can decide whether removing a block is worth it.

## Context Policies

Doing the same cleanup by hand at every Gate gets old. A **Context Policy** is a function over the Context that resector calls before every request; it returns operations, and resector applies them until it returns none.

```bash
/policy thinking-trail   # switch on
/policy off              # switch off
```

- **Same operations, same rules.** A policy can `remove`, `edit`, `move`, `compact` and add a `note` — nothing else, and each operation is checked like yours.
- **Transparent, not silent.** Every operation lands in the Session Log attributed to the policy, and the Gate shows what it did (`thinking-trail: 3 Tool Pairs removed, 5 Thinking → 1 Note`).
- **The policy wins.** Undo an operation and it is applied again before the next request. To keep something, switch the policy off.
- **Fails loudly.** A failing policy or Compaction stops the Gate instead of sending.
- **One at a time,** off after every start unless `defaultPolicy` is set.

### Built-in: `thinking-trail`

Drops Tool Calls and their results once the model has reasoned past them, and compacts its reasoning and answers into a running summary once the Context takes two thirds of the window. It tells the model what it does with a Note of its own.

### Write your own

Put a module into `~/.config/resector/policies/<name>.ts` — it is loaded at start and appears in `/policy`. The example [`examples/policies/lean-compact.ts`](examples/policies/lean-compact.ts) is a good start: from half the window on it removes read-only `bash` Tool Pairs (`grep`, `cat`, `git diff`, …) and short Thinking, then compacts the rest of the work into one Note — leaving your messages, the project's Notes and the newest Tool Pair alone.

```bash
cp examples/policies/lean-compact.ts ~/.config/resector/policies/
```

```ts
export const description = 'drops reads and short thinking, compacts at ½';

export default function leanCompact({ window, used, blocks: all }: PolicyContext): PolicyOperation[] {
  if (used < window * COMPACT_FROM) return [];
  // The model has not yet built on the newest block: it is left out, a Tool Pair as a whole.
  const last = all.at(-1);
  const newest = new Set([last?.id, last?.pair]);
  const blocks = all.filter(b => !newest.has(b.id));
  const reads = blocks.filter(b => isRead(b, blocks));
  const short = blocks.filter(b => b.kind === 'Thinking' && b.tokens < SHORT_THINKING);
  const gone = new Set([...reads.flatMap(b => [b.id, b.pair!]), ...short.map(b => b.id)]);
  const sources = blocks.filter(b => compactable(b) && !gone.has(b.id));
  const removals = [...reads, ...short].map(b => ({ op: 'remove' as const, id: b.id }));
  // Only the Note of an earlier Compaction left: compacting it again would not free the window.
  const worth = sources.some(b => b.origin !== 'compaction');
  return worth ? [...removals, { op: 'compact', sources: sources.map(b => b.id), instruction: INSTRUCTION }] : removals;
}
```

Each block has `id`, `kind`, `origin`, `content`, `tokens`, `pair` (the other half of its Tool Pair) and `pending`. The full interface is in [`src/core/policy/policy.ts`](src/core/policy/policy.ts), the design in [ADR 0001](docs/adr/0001-context-policies.md).

> [!NOTE]
> Policies are only loaded from your home directory, never from a project: a cloned repository cannot run code in your harness.

## Configuration

resector reads `~/.config/resector/config.jsonc` (or `$RESECTOR_CONFIG`) and then `.resector/config.jsonc` in the project, which may only tighten permissions. All options are in [`config.schema.json`](config.schema.json).

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/artkoenig/resector/main/config.schema.json",
  "profiles": {
    "qwen": {
      "backend": "llamacpp",               // llamacpp | ollama | lmstudio | omlx
      "endpoint": "http://localhost:8080",
      "model": "qwen3-coder",
      "thinking": "low",                   // off | on | effort level
      "toolProtocol": "native",            // native | text-xml
      "sampling": { "temperature": 0.6 },
      "compactionProfile": "qwen-small"
    }
  },
  "defaultProfile": "qwen",
  "defaultPolicy": "thinking-trail",
  "permission": {
    "npm test *": "allow",                 // `<command> *`: the command alone or with arguments
    "rm *": "ask",
    "git push *": "deny"
  }
}
```

A `system.md` next to a config file replaces the shipped system prompt.

### Slash commands

| Command | Description |
| --- | --- |
| `/policy <name>` | switch a Context Policy on or off |
| `/filter <kind>` | show or hide blocks of a kind |
| `/thinking <mode>` | set thinking for the next requests |
| `/tools <tool>` | switch `bash`, `search` or `question` on or off |
| `/auto` | auto-approve what the rules would ask for (`deny` still applies) |
| `/sessions` | list, resume, rename, delete sessions |
| `/rename <title>` | rename the session |
| `/git:branch <branch>` | show or switch the git branch |
| `/git:worktree <on\|off>` | run the session in its own git worktree |

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary: Context Block, Revision, Session Log, Review Gate, Compaction, Note, Context Policy, …
- [`docs/adr/`](docs/adr/) — design decisions
- [`docs/releasing.md`](docs/releasing.md) — builds and releases

## Contributing

```bash
bun install
bun run typecheck
bun test            # all tests; bun test <file> for one
bun run gate        # typecheck, coverage, dependency rules, mutation tests, duplication
```

Domain logic lives in `src/core/` (no I/O), model servers and the system in `src/adapters/`, the terminal UI (OpenTUI + Solid) in `src/ui/`. Bugs and ideas: [GitHub Issues](https://github.com/artkoenig/resector/issues).

## License

[MIT](LICENSE)
