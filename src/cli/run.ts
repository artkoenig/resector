// Headless Run from the command line (`resector -p`): a new session, the Gate without a screen, the answer on stdout,
// the closing status on stderr, the outcome as exit code.
import { homedir } from 'node:os';
import { createRoot } from 'solid-js';
import { configPaths } from '../adapters/fs/config';
import { projectSessionStore } from '../adapters/store/sessions';
import { openWorkspace } from '../compose/workspace';
import { createGate, type Outcome } from '../gate';
import { minimalView } from '../gate/minimal-view';
import { count, errorText, formatTokens } from '../gate/text';

// -p <prompt>.
export type Run = { prompt: string };

const INTERRUPTED = 130;
const EXIT: Record<Outcome['kind'], number> = { answer: 0, error: 1, 'max-turns': 1, aborted: INTERRUPTED };

export async function run(command: Run): Promise<number> {
  // Ctrl-C acts like Esc; a second one exits at once.
  const stop = new AbortController();
  const interrupt = () => (stop.signal.aborted ? process.exit(INTERRUPTED) : stop.abort());
  process.on('SIGINT', interrupt);
  try {
    const { outcome, id } = await headless(await withPiped(command.prompt), stop.signal).catch(e => ({ outcome: failed(errorText(e)), id: null }));
    if (outcome.kind === 'answer') process.stdout.write(`${outcome.text}\n`);
    process.stderr.write(closing(outcome, id));
    return EXIT[outcome.kind];
  } finally {
    process.off('SIGINT', interrupt);
  }
}

// The run on a new session; without a config it fails before one is opened.
async function headless(prompt: string, signal: AbortSignal): Promise<{ outcome: Outcome; id: string | null }> {
  const paths = configPaths({ home: homedir(), cwd: process.cwd(), env: process.env });
  const workspace = await openWorkspace({ paths, store: projectSessionStore(paths), openFile: async () => {}, onReopen: () => {} });
  const loaded = workspace.config();
  if (!loaded) return { outcome: failed(`no config at ${paths.global} – run resector once to set it up`), id: null };
  const opened = await workspace.open(loaded);
  try {
    const outcome = await createRoot(async dispose => {
      const gate = createGate({ ...opened.options, editor: async text => text, clipboard: async () => {}, openSessions: () => {} }, minimalView);
      try {
        return await gate.run({ prompt, signal });
      } finally {
        dispose();
      }
    });
    return { outcome, id: opened.id };
  } finally {
    opened.release();
  }
}

const failed = (text: string): Outcome => ({ kind: 'error', text: `resector: ${text}`, turns: 0, tokens: 0 });

// The error's text, where to go on after max-turns, then outcome, turns and tokens.
function closing({ kind, text, turns, tokens }: Outcome, id: string | null): string {
  const before = { error: [text], 'max-turns': [`turns used up – go on in resector: /sessions, or resector -c ${id}`], answer: [], aborted: [] }[kind];
  return [...before, `· ${kind} · ${count(turns, 'turn')} · ${formatTokens(tokens)} tokens`].map(l => `${l}\n`).join('');
}

// Piped input goes after the prompt; a terminal on stdin pipes nothing.
async function withPiped(prompt: string): Promise<string> {
  const piped = process.stdin.isTTY ? '' : (await Bun.stdin.text()).trim();
  return piped ? `${prompt}\n\n${piped}` : prompt;
}
