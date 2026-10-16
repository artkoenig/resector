// Headless Run from the command line (`resector -p`): a new session, the Gate without a screen, the answer on stdout,
// the closing status on stderr, the outcome as exit code.
import { homedir } from 'node:os';
import { createEffect, createRoot, on } from 'solid-js';
import { configPaths } from '../adapters/fs/config';
import { projectSessionStore } from '../adapters/store/sessions';
import { openTty } from '../adapters/terminal/tty';
import { openWorkspace } from '../compose/workspace';
import { headlessSettings, type Flags } from '../core/config/headless';
import type { SessionEvent } from '../core/log/events';
import { TOOL_NAMES } from '../core/tools/catalog';
import { createGate, type Outcome } from '../gate';
import { minimalView } from '../gate/minimal-view';
import { count, errorText, formatTokens } from '../gate/text';
import { createShow } from './show';

// -p <prompt> and its flags.
export type Run = { prompt: string; flags: Flags };

const INTERRUPTED = 130;
const USAGE = 2;
const EXIT: Record<Outcome['kind'], number> = { answer: 0, error: 1, 'max-turns': 1, aborted: INTERRUPTED };

// What a run uses of its process: `resector -p` passes the process's own (processIo), tests their own.
export type Io = {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  // The input piped in, '' from a terminal.
  piped(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  // Whether stderr is a terminal.
  color: boolean;
  // The terminal to ask at, null without one.
  tty(): ReturnType<typeof openTty>;
  // Aborted by Ctrl-C.
  signal: AbortSignal;
};

// Ctrl-C acts like Esc; a second one exits at once.
export function processIo(): Io {
  const stop = new AbortController();
  process.on('SIGINT', () => (stop.signal.aborted ? process.exit(INTERRUPTED) : stop.abort()));
  return {
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    piped: async () => (process.stdin.isTTY ? '' : Bun.stdin.text()),
    stdout: text => void process.stdout.write(text),
    stderr: text => void process.stderr.write(text),
    color: !!process.stderr.isTTY,
    tty: () => openTty(),
    signal: stop.signal,
  };
}

export async function run(command: Run, io: Io): Promise<number> {
  const piped = (await io.piped()).trim();
  const prompt = piped ? `${command.prompt}\n\n${piped}` : command.prompt;
  const ran = await headless({ ...command, prompt }, io).catch(e => ({ outcome: failed(errorText(e)), id: null }));
  if ('usage' in ran) {
    io.stderr(`resector: ${ran.usage}\n`);
    return USAGE;
  }
  const { outcome, id } = ran;
  if (outcome.kind === 'answer') io.stdout(`${outcome.text}\n`);
  io.stderr(closing(outcome, id));
  return EXIT[outcome.kind];
}

// The run on a new session with the settings; without a config, or with flags naming what does not exist, it fails
// before one is opened.
async function headless({ prompt, flags }: Run, io: Io): Promise<{ outcome: Outcome; id: string | null } | { usage: string }> {
  const paths = configPaths({ home: io.home, cwd: io.cwd, env: io.env });
  const workspace = await openWorkspace({ paths, store: projectSessionStore(paths), cwd: io.cwd, openFile: async () => {}, onReopen: () => {} });
  const loaded = workspace.config();
  if (!loaded) return { outcome: failed(`no config at ${paths.global} – run resector once to set it up`), id: null };
  const settings = headlessSettings(loaded.config, flags, { policies: workspace.policies.all.map(p => p.name), tools: TOOL_NAMES, repository: workspace.repository });
  if ('usage' in settings) return settings;
  const opened = await workspace.open(loaded, { start: settings });
  try {
    const show = createShow(settings.show ?? [], io.color);
    const toStderr = (text: string) => void (text && io.stderr(text));
    // Each event logged is shown as it happens.
    const log = {
      ...opened.options.log,
      append: (e: SessionEvent) => {
        opened.options.log.append(e);
        toStderr(show.event(e));
      },
    };
    const outcome = await createRoot(async dispose => {
      const gate = createGate({ ...opened.options, log, editor: async text => text, clipboard: async () => {}, openSessions: () => {} }, minimalView);
      createEffect(() => {
        const streaming = gate.streaming();
        toStderr(streaming ? show.thinking(streaming.thinking) : show.end());
      });
      // The session's opening notice is not news.
      createEffect(on(gate.status, status => status && toStderr(show.status(status)), { defer: true }));
      const tty = io.tty();
      try {
        return await gate.run({ prompt, signal: io.signal, maxTurns: settings.maxTurns, terminal: tty?.terminal });
      } finally {
        tty?.close();
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
