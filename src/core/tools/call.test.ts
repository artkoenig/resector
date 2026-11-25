import { expect, test } from 'bun:test';
import { constant, forAll, int, oneOf, pick, record, string, tuple } from '../../../test/property';
import { callArguments, parseCall, resultEnd, resultText } from './call';

test('a call of a tool switched off is not run', () => {
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls"}' }, [])).toEqual({ error: 'tool bash is off (/tools)' });
});

test('a bash call yields its command, a websearch call its query', () => {
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls -la"}' }, ['bash'])).toEqual({ tool: 'bash', content: 'ls -la' });
  expect(parseCall({ name: 'websearch', arguments: '{"query":"bun"}' }, ['bash', 'websearch'])).toEqual({ tool: 'websearch', content: 'bun' });
  expect(parseCall({ name: 'websearch', arguments: '{"query":"bun"}' }, ['bash'])).toEqual({ error: 'tool websearch is off (/tools)' });
  expect(parseCall({ name: 'skill', arguments: '{"name":"refactor"}' }, ['skill'])).toEqual({ tool: 'skill', content: 'refactor' });
  expect(parseCall({ name: 'skill', arguments: '{"name":"refactor"}' }, ['bash'])).toEqual({ error: 'tool skill is off (/tools)' });
  expect(parseCall({ name: 'image', arguments: '{"path":"shot.png"}' }, ['image'])).toEqual({ tool: 'image', content: 'shot.png' });
});

const QUESTION = { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], recommended: 'A' }] };

test('a bash call with background: true runs in the background; it is sent back with it', () => {
  expect(parseCall({ name: 'bash', arguments: '{"command":"serve","background":true}' }, ['bash'])).toEqual({ tool: 'bash', content: 'serve', background: true });
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls","background":false}' }, ['bash'])).toEqual({ tool: 'bash', content: 'ls' });
  expect(parseCall({ name: 'websearch', arguments: '{"query":"bun","background":true}' }, ['websearch'])).toEqual({ tool: 'websearch', content: 'bun' });
  expect(callArguments('bash', 'serve', { background: true })).toBe('{"command":"serve","background":true}');
});

test('a question call yields its arguments as content; an invalid one is rejected back to the model', () => {
  const args = JSON.stringify(QUESTION);
  expect(parseCall({ name: 'question', arguments: args }, ['question'])).toEqual({ tool: 'question', content: args });
  const invalid = JSON.stringify({ questions: [{ ...QUESTION.questions[0], recommended: 'C' }] });
  expect(parseCall({ name: 'question', arguments: invalid }, ['question'])).toEqual({ tool: 'question', content: invalid, rejected: 'question 1: recommended "C" is not an option label' });
  expect(parseCall({ name: 'question', arguments: args }, ['bash'])).toEqual({ error: 'tool question is off (/tools)' });
});

test('a call is sent back with the arguments it came with', () => {
  expect(callArguments('bash', 'ls -la')).toBe('{"command":"ls -la"}');
  expect(callArguments('websearch', 'bun')).toBe('{"query":"bun"}');
  expect(callArguments('skill', 'refactor')).toBe('{"name":"refactor"}');
  expect(callArguments('question', JSON.stringify(QUESTION))).toBe(JSON.stringify(QUESTION));
});

test('other tools, broken JSON or a missing command are not runnable', () => {
  expect(parseCall({ name: 'python', arguments: '{"command":"x"}' }, ['bash'])).toEqual({ error: 'unknown tool python' });
  expect(parseCall({ name: 'bash', arguments: '{"command":' }, ['bash'])).toEqual({ error: 'arguments are not valid JSON' });
  expect(parseCall({ name: 'bash', arguments: '{"cmd":"ls"}' }, ['bash'])).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'bash', arguments: 'null' }, ['bash'])).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'bash', arguments: '{"command":1}' }, ['bash'])).toEqual({ error: 'no command string' });
  expect(parseCall({ name: 'toString', arguments: '{}' }, ['toString'])).toEqual({ error: 'unknown tool toString' });
  expect(parseCall({ name: 'websearch', arguments: '{"command":"ls"}' }, ['websearch'])).toEqual({ error: 'no query string' });
  expect(parseCall({ name: 'skill', arguments: '{"cmd":"x"}' }, ['skill'])).toEqual({ error: 'no name string' });
});

test('the result is the output, then how the run ended', () => {
  expect(resultText({ output: 'a\nb\n\n', exit: 0, stopped: null }, 120)).toBe('a\nb\n[exit 0]');
  expect(resultText({ output: '', exit: 2, stopped: null }, 120)).toBe('[exit 2]');
  expect(resultText({ output: '  \n', exit: 1, stopped: null }, 120)).toBe('[exit 1]');
  expect(resultText({ output: 'partial', exit: null, stopped: 'killed' }, 120)).toBe('partial\n[killed]');
  expect(resultText({ output: '', exit: null, stopped: 'timeout' }, 5)).toBe('[timeout after 5 s]');
});

test('a result whose leftover processes were killed says so before how it ended', () => {
  expect(resultText({ output: 'a\n', exit: 0, stopped: null, leftover: true }, 120)).toBe('a\n[processes it left running were killed; start long-running ones with background: true]\n[exit 0]');
  expect(resultText({ output: '', exit: 0, stopped: null, leftover: true }, 120)).toBe('[processes it left running were killed; start long-running ones with background: true]\n[exit 0]');
});

test('a Background Process still running: its last 20 lines, then its pid, log and how to stop it', () => {
  const output = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 6}`).join('\n');
  expect(resultText({ output, exit: null, stopped: null, background: { pid: 42, log: '/h/42.log' } }, 120))
    .toBe(`${lines}\n[running in the background: pid 42 · log /h/42.log · stop: kill -- -42]`);
  expect(resultText({ output: '', exit: null, stopped: null, background: { pid: 42, log: '/h/42.log' } }, 120))
    .toBe('[running in the background: pid 42 · log /h/42.log · stop: kill -- -42]');
  // A Subagent's output is in its log only.
  expect(resultText({ output: 'a\n', exit: null, stopped: null, background: { pid: 42, log: '/h/42.log' } }, 120, 'subagent'))
    .toBe('[Subagent started: pid 42 · log /h/42.log · stop: kill -- -42]');
});

test('how the run ended is read back from the result; a result without that line has none', () => {
  expect(resultEnd('a\nb\n[exit 0]')).toEqual({ output: ['a', 'b'], end: 'exit 0' });
  expect(resultEnd('[timeout after 5 s]')).toEqual({ output: [], end: 'timeout after 5 s' });
  expect(resultEnd('denied by rule')).toEqual({ output: ['denied by rule'], end: null });
  // Only a whole last line in brackets says it.
  expect(resultEnd('[a] b')).toEqual({ output: ['[a] b'], end: null });
  expect(resultEnd('a [b]')).toEqual({ output: ['a [b]'], end: null });
});

// Property: a call sent back with its arguments parses to the same content, whatever it contains.
test('a call parses back from the arguments it is sent with', () => {
  forAll(tuple(pick('bash' as const, 'websearch' as const, 'skill' as const), string()), ([tool, content]) => {
    expect(parseCall({ name: tool, arguments: callArguments(tool, content) }, [tool])).toEqual({ tool, content });
  });
});

// Property: resultEnd reads back the output and how the run ended, whatever the output.
test('a Tool Result reads back as its output and its end', () => {
  const run = record({
    output: string(),
    exit: oneOf(constant(null), int(0, 255)),
    stopped: pick(null, 'killed' as const, 'timeout' as const),
  });
  forAll(run, r => {
    const { output, end } = resultEnd(resultText(r, 30));
    expect(output.join('\n')).toBe(r.output.trimEnd());
    expect(end).toBe(r.stopped === 'killed' ? 'killed' : r.stopped === 'timeout' ? 'timeout after 30 s' : `exit ${r.exit}`);
  });
});

test('a subagent call has a prompt, sent back as it came', () => {
  expect(parseCall({ name: 'subagent', arguments: '{"prompt":"look"}' }, ['subagent'])).toEqual({ tool: 'subagent', content: 'look' });
  expect(parseCall({ name: 'subagent', arguments: '{}' }, ['subagent'])).toEqual({ error: 'no prompt string' });
  expect(callArguments('subagent', 'look')).toBe('{"prompt":"look"}');
});

test('a subagent call with worktree: true runs in a worktree of its own; it is sent back with it', () => {
  expect(parseCall({ name: 'subagent', arguments: '{"prompt":"fix","worktree":true}' }, ['subagent'])).toEqual({ tool: 'subagent', content: 'fix', worktree: true });
  expect(parseCall({ name: 'subagent', arguments: '{"prompt":"fix","worktree":false}' }, ['subagent'])).toEqual({ tool: 'subagent', content: 'fix' });
  expect(parseCall({ name: 'bash', arguments: '{"command":"ls","worktree":true}' }, ['bash'])).toEqual({ tool: 'bash', content: 'ls' });
  expect(callArguments('subagent', 'fix', { worktree: true })).toBe('{"prompt":"fix","worktree":true}');
});

test('a Subagent started in a worktree: its result names the worktree and its branch', () => {
  const worktree = { path: '/data/worktrees/ses_a', branch: 'resector/ses_a', base: 'abc' };
  expect(resultText({ output: '', exit: null, stopped: null, background: { pid: 42, log: '/h/42.log', worktree } }, 120, 'subagent'))
    .toBe('[Subagent started: pid 42 · log /h/42.log · stop: kill -- -42 · worktree /data/worktrees/ses_a · branch resector/ses_a]');
});
