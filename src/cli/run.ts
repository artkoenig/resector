// Headless Run from the command line (`resector -p`): a new session, the Gate without a screen, the answer on stdout,
// the closing status on stderr, the outcome as exit code.
import { homedir } from 'node:os';
import { createEffect, createRoot, on } from 'solid-js';
import { REPORTS_ENV, writeReport } from '../adapters/bash/report';
import { configPaths } from '../adapters/fs/config';
import { projectSessionStore } from '../adapters/store/sessions';
import { openTty } from '../adapters/terminal/tty';
import { openWorkspace } from '../compose/workspace';
import type { Config } from '../core/config/config';
import { headlessSettings, SUBAGENT_ENV, SUBAGENT_SESSION_ENV, type Flags } from '../core/config/headless';
import type { SessionEvent, SubagentReport } from '../core/log/events';
import { DEFAULT_SUMMARY_PROMPT } from '../core/notes/subagent';
import { subagentTools, TOOL_NAMES } from '../core/tools/catalog';
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
  // SIGTERM or SIGHUP: `stop` runs (the running call and the Background Processes end), then the process exits.
  onTerminate(stop: () => Promise<void>): void;
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
    onTerminate: stop => {
      for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) process.on(signal, () => void stop().finally(() => process.exit(code)));
    },
  };
}

export async function run(command: Run, io: Io): Promise<number> {
  const piped = (await io.piped()).trim();
  const prompt = piped ? `${command.prompt}\n\n${piped}` : command.prompt;
  const reporter = createReporter(io);
  const ran = await headless({ ...command, prompt }, io, reporter).catch(e => ({ outcome: failed(errorText(e)), id: null }));
  // Already reported unless it failed on the way.
  reporter.failed('usage' in ran ? failed(ran.usage).text : ran.outcome.text);
  if ('usage' in ran) {
    io.stderr(`resector: ${ran.usage}\n`);
    return USAGE;
  }
  const { outcome, id } = ran;
  if (outcome.kind === 'answer') io.stdout(`${outcome.text}\n`);
  io.stderr(closing(outcome, id));
  return EXIT[outcome.kind];
}

// Whether the run is a Subagent, and the Session id its parent picked for it. The id is for the Subagent itself: what
// it starts does not inherit it. A run inside a Subagent is refused.
function subagentRole(env: Io['env']): { subagent: boolean; picked?: string } | { usage: string } {
  const mark = env[SUBAGENT_ENV];
  const picked = env[SUBAGENT_SESSION_ENV];
  delete env[SUBAGENT_SESSION_ENV];
  if (!mark) return { subagent: false };
  if (mark !== 'start') return { usage: 'a Subagent starts no Headless Runs' };
  if (picked !== undefined && !/^ses_[a-z0-9]+$/.test(picked)) return { usage: `${SUBAGENT_SESSION_ENV}: no session id` };
  return { subagent: true, ...(picked !== undefined && { picked }) };
}

// The run on a new session with the settings; without a config, or with flags naming what does not exist, it fails
// before one is opened.
async function headless({ prompt, flags }: Run, io: Io, reporter: Reporter): Promise<{ outcome: Outcome; id: string | null } | { usage: string }> {
  const role = subagentRole(io.env);
  if ('usage' in role) return role;
  const { subagent, picked } = role;
  const paths = configPaths({ home: io.home, cwd: io.cwd, env: io.env });
  const workspace = await openWorkspace({ paths, store: projectSessionStore(paths), cwd: io.cwd, openFile: async () => {}, onReopen: () => {} });
  const loaded = workspace.config();
  if (!loaded) return { outcome: failed(`no config at ${paths.global} – run resector once to set it up`), id: null };
  const settings = headlessSettings(loaded.config, flags, { policies: workspace.policies.all.map(p => p.name), tools: TOOL_NAMES, repository: workspace.repository });
  if ('usage' in settings) return settings;
  // A Subagent starts none itself: no tool for it, and what it starts inherits the
  // process's environment and finds itself inside one.
  if (subagent) {
    settings.tools = subagentTools(settings.tools);
    io.env[SUBAGENT_ENV] = 'inside';
  }
  const opened = await workspace.open(loaded, { start: settings, ...(picked && { id: picked }) });
  reporter.opened(opened.id);
  const terminated = new AbortController();
  let released: Promise<void> | undefined;
  const release = () => (released ??= opened.release());
  // The running call is in a process group of its own: without the abort it would outlive the run.
  io.onTerminate(() => {
    reporter.aborted();
    terminated.abort();
    return release();
  });
  try {
    const show = createShow(settings.show ?? [], io.color);
    const toStderr = (text: string) => void (text && io.stderr(text));
    // Each event logged is shown as it happens.
    const log = {
      ...opened.options.log,
      append: (e: SessionEvent) => {
        opened.options.log.append(e);
        reporter.logged(e);
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
        const outcome = await gate.run({ prompt, signal: AbortSignal.any([io.signal, terminated.signal]), maxTurns: settings.maxTurns, terminal: tty?.terminal, summary: summaryFor(subagent, loaded.config, reporter) });
        // Before the release, which may take long enough to be killed.
        reporter.ended(outcome);
        return outcome;
      } finally {
        tty?.close();
        dispose();
      }
    });
    return { outcome, id: opened.id };
  } finally {
    // One release for both: terminated, its exit code comes first.
    await release();
  }
}

// Only a Subagent is asked for a summary.
const summaryFor = (subagent: boolean, config: Config, { asking }: Reporter) =>
  subagent ? { prompt: config.subagent?.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT, asking } : undefined;

type Reporter = ReturnType<typeof createReporter>;

// A Subagent's report to its parent Session, kept up to date so that a kill leaves one too; how it ended first stays.
// Nothing for other Headless Runs.
export function createReporter(io: Pick<Io, 'env' | 'stderr'>) {
  const dir = io.env[SUBAGENT_ENV] === 'start' ? io.env[REPORTS_ENV] : undefined;
  // Not for what the Subagent starts.
  delete io.env[REPORTS_ENV];
  let report: SubagentReport = { turns: 0, tokens: 0 };
  // The run goes on: its requests are turns.
  let running = true;
  function update(more: Partial<SubagentReport>) {
    if (!dir || report.outcome) return;
    report = { ...report, ...more };
    // No reason for the run to fail: the parent learns of the end without it.
    try {
      writeReport(dir, process.pid, report);
    } catch (e) {
      io.stderr(`resector: report: ${errorText(e)}\n`);
    }
  }
  return {
    opened: (session: string) => update({ session }),
    logged(e: SessionEvent) {
      if (running && e.type === 'RequestSent') update({ turns: report.turns + 1, tokens: e.tokens });
    },
    asking() {
      running = false;
    },
    failed: (text: string) => update({ outcome: 'error', text }),
    aborted: () => update({ outcome: 'aborted' }),
    ended: (outcome: Outcome) => update({ outcome: outcome.kind, turns: outcome.turns, tokens: outcome.tokens, text: reported(outcome) }),
  };
}
// What the parent reads below the head: the summary or why there is none, an error's status text.
function reported({ text, summary, kind }: Outcome): string {
  if (!summary) return kind === 'error' ? text : '';
  return 'text' in summary ? summary.text : `no summary: ${summary.error}`;
}

const failed = (text: string): Outcome => ({ kind: 'error', text: `resector: ${text}`, turns: 0, tokens: 0 });

// The error's text, where to go on after max-turns, then outcome, turns and tokens.
function closing({ kind, text, turns, tokens }: Outcome, id: string | null): string {
  const before = { error: [text], 'max-turns': [`turns used up – go on in resector: /sessions, or resector -c ${id}`], answer: [], aborted: [] }[kind];
  return [...before, `· ${kind} · ${count(turns, 'turn')} · ${formatTokens(tokens)} tokens`].map(l => `${l}\n`).join('');
}
