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

// A project with a config on the fake server, unless config is false; headless: its headless section; permission: its
// rules; tty: the lines
// typed at the terminal (the asking goes to <file>.out), none when there is no terminal.
function project({ config = true, headless = {}, permission, tty, bash }: { config?: boolean; headless?: object; permission?: object; tty?: string[]; bash?: object } = {}) {
  fake = startFakeLlamaCpp({ nCtx: 4096 });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resector-cli-')));
  const dir = join(root, 'project');
  mkdirSync(dir);
  const env = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), RESECTOR_CONFIG: join(root, 'config.jsonc') };
  const typed = join(root, 'tty');
  if (tty) writeFileSync(typed, tty.map(l => `${l}\n`).join(''));
  if (config) writeFileSync(env.RESECTOR_CONFIG, JSON.stringify({ profiles: { local: { backend: 'llamacpp', endpoint: fake.url, window: 2048 } }, defaultProfile: 'local', headless, permission, bash }));
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
    onTerminate: () => {},
  };
  const code = await run(command.run, io);
  return { out, err, code };
}

// Runs resector as a process with args; stdin: piped input; interrupt: Ctrl-C once the model was asked.
// terminate: SIGTERM once the model was asked that many times.
async function resector(p: ReturnType<typeof project>, args: string[], { stdin, interrupt = false, terminate }: { stdin?: string; interrupt?: boolean; terminate?: number } = {}) {
  const proc = Bun.spawn(['bun', MAIN, ...args], { cwd: p.dir, env: { ...process.env, RESECTOR_SUBAGENT: undefined, ...p.env }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  if (interrupt) void (async () => {
    while (!fake.chatRequests.length) await Bun.sleep(10);
    proc.kill('SIGINT');
  })();
  if (terminate) void (async () => {
    while (fake.chatRequests.length < terminate) await Bun.sleep(10);
    proc.kill('SIGTERM');
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

test('without Auto-approve a call the rules ask for is asked at the terminal, not on stderr, and runs on y', async () => {
  const asked = project({ permission: { 'touch *': 'ask' }, tty: ['y'] });
  reply({ calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'touch made' }) }] });
  reply({ chunks: ['done'] });
  const { out, err } = await resectorHere(asked, ['-p', 'go', '--no-auto-approve']);
  expect(out).toBe('done\n');
  expect(err).not.toContain('approve');
  expect(readFileSync(`${asked.typed}.out`, 'utf8')).toStartWith('? approve touch made\n  ? touch made (');
  expect(existsSync(join(asked.dir, 'made'))).toBe(true);
});

test('a call inside the project runs without asking, also without a terminal', async () => {
  const unattended = project();
  reply({ calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'touch made' }) }] });
  reply({ chunks: ['done'] });
  expect((await resectorHere(unattended, ['-p', 'go'])).out).toBe('done\n');
  expect(existsSync(join(unattended.dir, 'made'))).toBe(true);
});

test('without Auto-approve and a terminal a call the rules ask for is not run; the run goes on', async () => {
  const unattended = project({ permission: { 'touch *': 'ask' } });
  reply({ calls: [{ name: 'bash', arguments: JSON.stringify({ command: 'touch made' }) }] });
  reply({ chunks: ['done'] });
  expect((await resectorHere(unattended, ['-p', 'go', '--no-auto-approve'])).out).toBe('done\n');
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

// A Background Process writing its pid, so the test can see whether it still runs.
const SERVE = { name: 'bash', arguments: JSON.stringify({ command: 'bash serve.sh', background: true }) };
const withServer = (p: ReturnType<typeof project>) => (writeFileSync(join(p.dir, 'serve.sh'), 'echo $$ > server.pid; echo up; sleep 30\n'), p);
const serverAlive = (dir: string) => {
  try {
    process.kill(-Number(readFileSync(join(dir, 'server.pid'), 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
};

test('a Background Process the run started ends with the run; its result went to the model', async () => {
  const p = withServer(project({ bash: { backgroundWait: 0.3 } }));
  reply({ calls: [SERVE] });
  reply({ chunks: ['served'] });
  expect((await resectorHere(p, ['-p', 'go'])).out).toBe('served\n');
  expect(JSON.stringify(fake.chatRequests[1])).toContain('[running in the background: pid ');
  expect(p.sessions()[0]).toContain('"type":"BackgroundStarted"');
  expect(serverAlive(p.dir)).toBe(false);
});

test('SIGTERM stops the Background Processes, then exits 143', async () => {
  const p = withServer(project({ bash: { backgroundWait: 0.3 } }));
  reply({ calls: [SERVE] });
  reply({ chunks: ['partial'], hang: true });
  const { code } = await resector(p, ['-p', 'go'], { terminate: 2 });
  expect(code).toBe(143);
  expect(existsSync(join(p.dir, 'server.pid'))).toBe(true);
  expect(serverAlive(p.dir)).toBe(false);
});

test('inside a Subagent -p is a usage error: it starts none itself', async () => {
  const p = project();
  Object.assign(p.env, { RESECTOR_SUBAGENT: 'inside' });
  expect(await resectorHere(p, ['-p', 'hi'])).toEqual({ out: '', err: 'resector: a Subagent starts no Headless Runs\n', code: 2 });
  expect(p.sessions()).toEqual([]);
});

test('a Subagent has no subagent tool, also when the config names it, and marks its environment', async () => {
  const p = project({ headless: { tools: ['bash', 'subagent'] } });
  Object.assign(p.env, { RESECTOR_SUBAGENT: 'start' });
  reply({ chunks: ['ok'] });
  expect((await resectorHere(p, ['-p', 'hi'])).code).toBe(0);
  expect(offered(0)).toEqual(['bash']);
  expect((p.env as Record<string, string>).RESECTOR_SUBAGENT).toBe('inside');
});

// The tools offered with a request.
const offered = (request: number) => (fake.chatRequests[request] as { tools?: { function: { name: string } }[] }).tools?.map(t => t.function.name);

test('a run starts a Subagent: a run with a Session of its own, on the parent\'s profile, whose result text came at once', async () => {
  const p = project();
  const prompt = "-look at 'this' \"too\" $HOME";
  // The parent waits for the Subagent's end; until then the only other request is the Subagent's.
  const wait = `until grep -qs '^· answer' ${p.env.XDG_DATA_HOME}/resector/projects/*/background/*/*.log; do sleep 0.1; done`;
  reply({ calls: [{ name: 'subagent', arguments: JSON.stringify({ prompt }) }, { name: 'bash', arguments: JSON.stringify({ command: wait }) }] });
  reply({ chunks: ['child done'] });
  reply({ chunks: ['parent done'] });
  const { out, code, err } = await resector(p, ['-p', 'go', '--auto-approve', '--show', 'tools']);
  expect({ out, code }).toEqual({ out: 'parent done\n', code: 0 });
  expect(err).toContain('Subagent started: pid ');
  expect(err).toContain(`$ subagent ${prompt}`);
  expect(offered(0)).toContain('subagent');
  expect(offered(1)).not.toContain('subagent');
  const [child] = p.sessions().filter(s => s.includes('child done'));
  expect(child).toContain(JSON.stringify(prompt));
  expect(p.sessions()).toHaveLength(2);
  expect(child).not.toContain('"content":"go"');
}, 20_000);
