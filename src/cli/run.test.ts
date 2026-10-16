// Headless Run end to end against the fake llama.cpp server: `resector -p` in this process on its own Io, and as a
// process for what only one has (stdin, Ctrl-C, exit code).
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeLlamaCpp, type Reply } from '../../test/fake-llamacpp';
import { configPaths } from '../adapters/fs/config';
import { projectSessionsDir } from '../adapters/store/session-log';
import { openTty } from '../adapters/terminal/tty';
import { main } from '../main';
import { run } from './run';

const MAIN = join(import.meta.dir, '..', 'main.ts');
let fake: ReturnType<typeof startFakeLlamaCpp>;
afterEach(() => fake.stop());

// A project with a config on the fake server, unless config is false; headless: its headless section; tty: the lines
// typed at the terminal (the asking goes to <file>.out), none when there is no terminal.
function project({ config = true, headless = {}, tty }: { config?: boolean; headless?: object; tty?: string[] } = {}) {
  fake = startFakeLlamaCpp({ nCtx: 4096 });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resector-cli-')));
  const dir = join(root, 'project');
  mkdirSync(dir);
  const env = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), RESECTOR_CONFIG: join(root, 'config.jsonc') };
  const typed = join(root, 'tty');
  if (tty) writeFileSync(typed, tty.map(l => `${l}\n`).join(''));
  if (config) writeFileSync(env.RESECTOR_CONFIG, JSON.stringify({ profiles: { local: { backend: 'llamacpp', endpoint: fake.url, window: 2048 } }, defaultProfile: 'local', headless }));
  const sessions = () => {
    const at = projectSessionsDir(configPaths({ home: env.HOME, cwd: dir, env }));
    return (existsSync(at) ? readdirSync(at) : []).filter(f => f.endsWith('.jsonl')).map(f => readFileSync(join(at, f), 'utf8'));
  };
  return { dir, env, sessions, typed: tty ? typed : null };
}

// Runs resector -p in this process, its Io the project's.
async function resectorHere(p: ReturnType<typeof project>, args: string[]) {
  const command = main(args);
  if (!('run' in command)) throw new Error(`not a run: ${JSON.stringify(command)}`);
  let out = '';
  let err = '';
  const io = {
    cwd: p.dir,
    home: p.env.HOME,
    env: p.env,
    piped: async () => '',
    stdout: (text: string) => void (out += text),
    stderr: (text: string) => void (err += text),
    color: false,
    tty: () => (p.typed ? openTty(p.typed, `${p.typed}.out`) : null),
    signal: new AbortController().signal,
  };
  const code = await run(command.run, io);
  return { out, err, code };
}

// Runs resector as a process with args; stdin: piped input; interrupt: Ctrl-C once the model was asked.
async function resector(p: ReturnType<typeof project>, args: string[], { stdin, interrupt = false }: { stdin?: string; interrupt?: boolean } = {}) {
  const proc = Bun.spawn(['bun', MAIN, ...args], { cwd: p.dir, env: { ...process.env, ...p.env }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  if (interrupt) void (async () => {
    while (!fake.chatRequests.length) await Bun.sleep(10);
    proc.kill('SIGINT');
  })();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

const reply = (r: Partial<Reply>) => fake.reply({ chunks: [], ...r });

test('the answer goes to stdout, the closing status line to stderr; the run is a logged session', async () => {
  const p = project();
  reply({ chunks: ['hello', ' there'] });
  const { out, err, code } = await resector(p, ['-p', 'hi']);
  expect({ out, code }).toEqual({ out: 'hello there\n', code: 0 });
  expect(err).toMatch(/· answer · 1 turn · \S+ tokens\n$/);
  expect(p.sessions()).toEqual([expect.stringContaining('"content":"hi"')]);
});

test('piped input is appended to the prompt', async () => {
  const p = project();
  reply({ chunks: ['ok'] });
  expect((await resector(p, ['-p', 'summarize'], { stdin: 'line one\nline two\n' })).code).toBe(0);
  expect(p.sessions()[0]).toContain(JSON.stringify('summarize\n\nline one\nline two'));
});

test('an error exits 1 with the Gate\'s status text on stderr and nothing on stdout', async () => {
  const p = project();
  reply({ error: 'model crashed' });
  const { out, err, code } = await resectorHere(p, ['-p', 'hi']);
  expect({ out, code }).toEqual({ out: '', code: 1 });
  expect(err).toMatch(/^backend error: .*model crashed.*\n· error · 1 turn · /);
});

test('an unreachable backend exits 1 with the closing status line', async () => {
  const p = project();
  fake.stop();
  const { out, err, code } = await resectorHere(p, ['-p', 'hi']);
  expect({ out, code }).toEqual({ out: '', code: 1 });
  expect(err).toMatch(/^resector: .+\n· error · 0 turns · 0 tokens\n$/);
});

test('without a config the run fails with a hint', async () => {
  const p = project({ config: false });
  const { out, err, code } = await resectorHere(p, ['-p', 'hi']);
  expect({ out, code }).toEqual({ out: '', code: 1 });
  expect(err).toMatch(/^resector: no config at .*\n· error · 0 turns · 0 tokens\n$/);
});

test('a usage error exits 2: -p with -c, a flag of -p without it', async () => {
  const p = project();
  for (const args of [['-p', 'hi', '-c'], ['-m', 'local']]) {
    const { out, err, code } = await resector(p, args);
    expect({ out, code }).toEqual({ out: '', code: 2 });
    expect(err).toStartWith('usage: resector');
  }
});

test('a flag beats the headless config section', async () => {
  const p = project({ headless: { tools: ['bash'] } });
  reply({ chunks: ['ok'] });
  reply({ chunks: ['ok'] });
  expect((await resectorHere(p, ['-p', 'hi'])).code).toBe(0);
  expect((await resectorHere(p, ['-p', 'hi', '--tools', 'none'])).code).toBe(0);
  const tools = fake.chatRequests.map(r => (r as { tools?: { function: { name: string } }[] }).tools?.map(t => t.function.name));
  expect(tools).toEqual([['bash'], undefined]);
});

test('an unknown profile is a usage error naming the valid ones', async () => {
  const p = project();
  expect(await resectorHere(p, ['-p', 'hi', '-m', 'big'])).toEqual({ out: '', err: 'resector: unknown profile big (profiles: local)\n', code: 2 });
});

test('a worktree outside a git repository is a usage error; no session is made', async () => {
  const p = project();
  expect(await resectorHere(p, ['-p', 'hi', '-w'])).toEqual({ out: '', err: 'resector: worktree: not a git repository\n', code: 2 });
  expect(p.sessions()).toEqual([]);
});

test('--show all puts thinking, calls and results on stderr; stdout is the answer only', async () => {
  const p = project();
  reply({ thinking: ['Let me', ' look'], chunks: [], calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) }] });
  reply({ chunks: ['done'] });
  const shown = await resectorHere(p, ['-p', 'go', '--show', 'all', '--auto-approve']);
  expect({ out: shown.out, code: shown.code }).toEqual({ out: 'done\n', code: 0 });
  expect(shown.err).toStartWith('◆ summary-reset: note → How this session works: your context is limited. Once your work since the start…\n');
  expect(shown.err).toContain('\n∴ Let me look\n$ echo hi\n  │ hi\n  └ exit 0\n');
  expect(shown.err).toMatch(/\n· answer · 2 turns · \S+ tokens\n$/);
});

test('without --show stderr is the closing status line only', async () => {
  const p = project();
  reply({ thinking: ['hm'], chunks: ['quiet'] });
  expect((await resectorHere(p, ['-p', 'go'])).err).toMatch(/^· answer · 1 turn · \S+ tokens\n$/);
});

test('a call the rules ask for is asked at the terminal, not on stderr, and runs on y', async () => {
  const asked = project({ tty: ['y'] });
  reply({ calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'touch made' }) }] });
  reply({ chunks: ['done'] });
  const { out, err } = await resectorHere(asked, ['-p', 'go']);
  expect(out).toBe('done\n');
  expect(err).not.toContain('approve');
  expect(readFileSync(`${asked.typed}.out`, 'utf8')).toStartWith('? approve touch made\n  ? touch made (');
  expect(existsSync(join(asked.dir, 'made'))).toBe(true);
});

test('without a terminal a call the rules ask for is not run; the run goes on', async () => {
  const unattended = project();
  reply({ calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'touch made' }) }] });
  reply({ chunks: ['done'] });
  expect((await resectorHere(unattended, ['-p', 'go'])).out).toBe('done\n');
  expect(existsSync(join(unattended.dir, 'made'))).toBe(false);
  expect(unattended.sessions()[0]).toContain('no user to approve');
});

test('Ctrl-C aborts the run: exit 130, nothing on stdout', async () => {
  const p = project();
  reply({ chunks: ['partial'], hang: true });
  const { out, err, code } = await resector(p, ['-p', 'hi'], { interrupt: true });
  expect({ out, code }).toEqual({ out: '', code: 130 });
  expect(err).toContain('· aborted · 1 turn');
});
