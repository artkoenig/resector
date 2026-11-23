// PROTOTYPE, throwaway (wayfinder ticket #174): what the parent's model reads of a Subagent, in three variants.
// Run: bun src/core/notes/subagent-note.prototype.ts [A|B|C]

type Outcome = 'answer' | 'error' | 'max-turns' | 'aborted';
type Ended = {
  pid: number;
  prompt: string;
  outcome: Outcome | 'stopped by the user' | 'stopped when the session ended';
  text: string; // the last answer, or the error's status text
  turns: number;
  tokens: string;
  session: string;
  worktree?: { path: string; branch: string };
};

const HOME = '~/.resector/projects/resector';
const log = (e: Ended) => `${HOME}/background/${e.pid}.log`;
const answerFile = (e: Ended) => `${HOME}/background/${e.pid}.answer.md`;
const firstLine = (s: string) => (s.split('\n')[0]!.length > 70 ? `${s.split('\n')[0]!.slice(0, 69)}…` : s.split('\n')[0]!);

// The Tool Result of the `subagent` call, right after the start (same in every variant).
const started = (e: Ended) => `[Subagent started: pid ${e.pid} · log ${log(e)} · stop: kill -- -${e.pid}]`;

const head = (e: Ended) =>
  [
    `Subagent pid ${e.pid} ended: ${e.outcome} · ${e.turns} turns · ${e.tokens} tokens`,
    `prompt: ${firstLine(e.prompt)}`,
    e.worktree ? `worktree: ${e.worktree.path} · branch ${e.worktree.branch}` : null,
    `session: ${e.session} · log: ${log(e)}`,
  ]
    .filter(Boolean)
    .join('\n');

// A: a pointer only, as a Background Process's exit Note today. The model reads the answer with bash.
const A = (e: Ended) => `${head(e)}\nanswer: ${answerFile(e)}`;

// B: the whole answer in the Note.
const B = (e: Ended) => `${head(e)}\n\n${e.text}`;

// C: the answer in the Note up to a cap; the rest stays in a file.
const CAP = 1200;
const C = (e: Ended) => {
  if (e.text.length <= CAP) return B(e);
  const rest = e.text.length - CAP;
  return `${head(e)}\n\n${e.text.slice(0, CAP)}\n[… ${rest} more characters: ${answerFile(e)}]`;
};

const long = Array.from({ length: 60 }, (_, i) => `- src/gate/slice-${i}.ts: calls kernel.append in ${i + 1} places, e.g. when a Tool Result arrives`).join('\n');

const scenarios: Record<string, Ended[]> = {
  'short answer, read-only': [
    { pid: 4242, prompt: 'Find where the Session Log is written and list the call sites.', outcome: 'answer', text: 'The Session Log is appended in `src/adapters/store/sessions.ts` (`append`). Call sites: `gate/kernel.ts:41` only; every slice goes through `k.append`.', turns: 6, tokens: '18.2k', session: '2026-11-23-find-where-the-session' },
  ],
  'long answer': [
    { pid: 4243, prompt: 'List every place the Gate appends to the log, with file and reason.', outcome: 'answer', text: `60 places:\n${long}`, turns: 14, tokens: '41k', session: '2026-11-23-list-every-place' },
  ],
  'wrote in a worktree': [
    { pid: 4250, prompt: 'Rename `foldBlocks` to `fold` everywhere and make the tests pass.\nDo not touch docs.', outcome: 'answer', text: 'Renamed in 7 files, committed as `a1b2c3d`. `bun test`: 412 pass.', turns: 22, tokens: '63k', session: '2026-11-23-rename-foldblocks', worktree: { path: `${HOME}/worktrees/rename-foldblocks`, branch: 'resector/rename-foldblocks' } },
  ],
  'max turns, error, killed': [
    { pid: 4260, prompt: 'Make the flaky launch test deterministic.', outcome: 'max-turns', text: 'I have narrowed it to the fake server start; next I would …', turns: 50, tokens: '120k', session: '2026-11-23-make-the-flaky' },
    { pid: 4261, prompt: 'Summarise docs/adr.', outcome: 'error', text: 'backend unreachable: http://mac-studio.local:8080', turns: 0, tokens: '0', session: '2026-11-23-summarise-docs-adr' },
    { pid: 4262, prompt: 'Count the tests per folder.', outcome: 'stopped by the user', text: '', turns: 3, tokens: '9k', session: '2026-11-23-count-the-tests' },
  ],
};

const variants = { A, B, C };
const names = { A: 'pointer only', B: 'whole answer in the Note', C: `answer in the Note, capped at ${CAP} characters` };
const pick = (process.argv[2]?.toUpperCase() ?? '') as keyof typeof variants;

console.log(`### Tool Result of the subagent call (every variant)\n${started(scenarios['short answer, read-only']![0]!)}\n`);
for (const v of (pick in variants ? [pick] : ['A', 'B', 'C']) as (keyof typeof variants)[]) {
  console.log(`\n${'='.repeat(78)}\n## Variant ${v}: ${names[v]}\n${'='.repeat(78)}`);
  for (const [name, ended] of Object.entries(scenarios)) {
    console.log(`\n--- ${name} (${ended.length} Note${ended.length > 1 ? 's, before the same request' : ''}) ---`);
    for (const e of ended) console.log(`\n[Note]\n${variants[v](e)}`);
  }
}
