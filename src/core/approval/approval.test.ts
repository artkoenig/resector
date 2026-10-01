import { expect, test } from 'bun:test';
import { BUILTIN_ALLOW, deniedTools, evaluate, matches, verdictOf, permissionRules, prefixRule, quoted, sessionAllowed, sessionRules, type Command, type Rule, type Split } from './approval';

const ROOT = '/work/project';
// A split that treats `&&` as the only separator and every word after the first as a literal argument.
const words: Split = command => (command.includes('"') ? null : command.split('&&').map(text => ({ text: text.trim(), args: text.trim().split(/\s+/).slice(1), writes: [] })));
const rule = (pattern: string, action: Rule['action'], source: Rule['source'] = 'global'): Rule => ({ pattern, action, source });
const verdict = (command: string, rules: Rule[] = BUILTIN_ALLOW, split: Split = words) => evaluate(command, { rules, split, root: ROOT });
const only = (command: Command) => () => [command];

test('search is always allowed, whatever the rules; a bash call is decided by them', () => {
  const input = { rules: [rule('*', 'deny')], split: words, root: ROOT };
  expect(verdictOf({ tool: 'search', content: 'rm -rf /' }, input)).toEqual({ action: 'allow', checks: [] });
  expect(verdictOf({ content: 'ls' }, input).action).toBe('deny');
  expect(verdictOf({ tool: 'bash', content: 'ls' }, input).action).toBe('deny');
});

test('a Question is never asked for: only a rule for `question` denies it, the last one wins', () => {
  const input = (...rules: Rule[]) => ({ rules, split: words, root: ROOT });
  const question = { tool: 'question' as const, content: '{}' };
  expect(verdictOf(question, input(rule('*', 'deny'), rule('question *', 'deny'), rule('question', 'ask')))).toEqual({ action: 'allow', checks: [] });
  expect(verdictOf(question, input(rule('question', 'deny', 'project')))).toEqual({
    action: 'deny',
    checks: [{ text: 'question', action: 'deny', why: 'project rule "question"', unallowable: false }],
  });
  expect(verdictOf(question, input(rule('question', 'deny'), rule('question', 'allow', 'session'))).action).toBe('allow');
  expect(verdictOf(question, input()).action).toBe('allow');
  expect(verdictOf(question, input(rule('question', 'deny'), rule('ls *', 'allow'))).action).toBe('deny');
  expect(deniedTools([rule('question', 'deny')])).toEqual(['question']);
  expect(deniedTools([rule('question', 'deny'), rule('question', 'ask', 'project')])).toEqual(['question']);
  expect(deniedTools([rule('question', 'deny'), rule('question', 'allow')])).toEqual([]);
  expect(deniedTools(permissionRules({ question: 'allow' }, { question: 'deny' }))).toEqual(['question']);
  expect(deniedTools(permissionRules({ question: 'deny' }, { question: 'allow' }))).toEqual([]);
});

test('a pattern ending in " *" matches the command alone or with arguments, not a longer word', () => {
  expect(matches('git status *', 'git status')).toBe(true);
  expect(matches('git status *', 'git status --short')).toBe(true);
  expect(matches('git status *', 'git statuses')).toBe(false);
  expect(matches('git status *', 'git')).toBe(false);
});

test('any other * matches anything, across lines; the rest literally', () => {
  expect(matches('npm*', 'npm')).toBe(true);
  expect(matches('npm*', 'npmx run')).toBe(true);
  expect(matches('echo * > out', 'echo a\nb > out')).toBe(true);
  expect(matches('a.b', 'axb')).toBe(false);
  expect(matches('ls', 'ls -la')).toBe(false);
  expect(matches('(x)+', '(x)+')).toBe(true);
});

test('runs of whitespace in the command count as one space', () => {
  expect(matches('git status *', 'git   status\t-s')).toBe(true);
  expect(matches('git status *', '  git status ')).toBe(true);
});

test('the built-in allow list: read-only commands', () => {
  const allowed = ['ls', 'cat a', 'head a', 'tail a', 'wc a', 'grep x a', 'rg x', 'find .', 'sed -n 1p a', 'git status', 'git diff', 'git log', 'git show HEAD'];
  for (const command of allowed) expect(verdict(command).action, command).toBe('allow');
  for (const command of ['sed -i s/a/b/ a', 'git push', 'rm a']) expect(verdict(command).action, command).toBe('ask');
  expect(BUILTIN_ALLOW.every(r => r.action === 'allow' && r.source === 'built-in')).toBe(true);
});

test('no rule matching: ask', () => {
  expect(verdict('make')).toEqual({ action: 'ask', checks: [{ text: 'make', action: 'ask', why: 'no rule → default ask', unallowable: false }] });
});

test('the last matching rule wins', () => {
  const rules = [rule('git *', 'deny'), rule('git status *', 'allow'), rule('npm *', 'allow'), rule('npm publish *', 'ask')];
  expect(verdict('git status', rules).checks[0]).toEqual({ text: 'git status', action: 'allow', why: 'global rule "git status *"', unallowable: false });
  expect(verdict('git push', rules).checks[0]).toEqual({ text: 'git push', action: 'deny', why: 'global rule "git *"', unallowable: false });
  expect(verdict('npm publish', rules).action).toBe('ask');
});

test('every sub-command must be allowed: one ask makes the call ask, one deny denies it', () => {
  const rules = [...BUILTIN_ALLOW, rule('rm *', 'deny')];
  expect(verdict('ls && cat a', rules).action).toBe('allow');
  expect(verdict('ls && make', rules)).toEqual({
    action: 'ask',
    checks: [
      { text: 'ls', action: 'allow', why: 'built-in rule "ls *"', unallowable: false },
      { text: 'make', action: 'ask', why: 'no rule → default ask', unallowable: false },
    ],
  });
  expect(verdict('make && rm a && ls', rules).action).toBe('deny');
});

test('a command that does not parse: ask, and no session rule can allow it', () => {
  expect(verdict('echo "open')).toEqual({ action: 'ask', checks: [{ text: 'echo "open', action: 'ask', why: 'unparseable', unallowable: true }] });
});

test('a command with nothing to run: ask', () => {
  expect(verdict('# only a comment', BUILTIN_ALLOW, () => [])).toEqual({ action: 'ask', checks: [{ text: '# only a comment', action: 'ask', why: 'no command', unallowable: true }] });
});

test('an argument outside the project turns allow into ask, which no session rule changes', () => {
  const outside = (arg: string) => verdict('cat', BUILTIN_ALLOW, only({ text: `cat ${arg}`, args: [arg], writes: [] })).checks[0]!;
  expect(outside('/etc/passwd')).toEqual({ text: 'cat /etc/passwd', action: 'ask', why: 'argument outside project: /etc/passwd', unallowable: true });
  expect(outside('../secret').why).toBe('argument outside project: ../secret');
  expect(outside('src/../../x').action).toBe('ask');
  expect(outside('~/.ssh/id_rsa').action).toBe('ask');
  expect(outside('~').action).toBe('ask');
  expect(outside('--file=/etc/passwd').why).toBe('argument outside project: --file=/etc/passwd');
  expect(outside('/work/project-other/x').action).toBe('ask');
  expect(outside('-f=/etc/passwd').action).toBe('ask');
  expect(outside('-f/etc/shadow').why).toBe('argument outside project: -f/etc/shadow');
  expect(outside('-I../include').action).toBe('ask');
  expect(outside('-I~/x').action).toBe('ask');
});

test('arguments inside the project, flags and the null devices are fine', () => {
  const inside = (arg: string) => verdict('cat', BUILTIN_ALLOW, only({ text: `cat ${arg}`, args: [arg], writes: [] })).action;
  for (const arg of ['a.txt', 'src/../lib/x', './x', '/work/project', '/work/project/src/a.ts', '-n', '--lines=5', '/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', 'a~b', '-', '.--b=./x', '-n5', '-Isrc', '-I./src', 'x-f/etc', '.-f./x']) expect(inside(arg), arg).toBe('allow');
});

test('any argument outside the project asks, not only the first', () => {
  expect(verdict('cat', BUILTIN_ALLOW, only({ text: 'cat a /etc/x', args: ['a', '/etc/x'], writes: [] })).checks[0]!.why).toBe('argument outside project: /etc/x');
});

test('an argument that is not literal ($VAR, $(…)) could point anywhere: ask', () => {
  const check = verdict('cat', BUILTIN_ALLOW, only({ text: 'cat $HOME/x', args: [null], writes: [] })).checks[0];
  expect(check).toEqual({ text: 'cat $HOME/x', action: 'ask', why: 'argument not literal', unallowable: true });
});

test('a denied command stays denied whatever its arguments', () => {
  const rules = [rule('rm *', 'deny')];
  expect(verdict('rm', rules, only({ text: 'rm -rf /', args: ['-rf', '/'], writes: [] })).checks[0]!.action).toBe('deny');
  expect(verdict('rm', rules, only({ text: 'rm $X', args: [null], writes: [] })).checks[0]!.action).toBe('deny');
});

test('a redirect target outside the project: ask', () => {
  const check = verdict('ls', BUILTIN_ALLOW, only({ text: 'ls', args: [], writes: ['/tmp/out'] })).checks[0];
  expect(check).toEqual({ text: 'ls', action: 'ask', why: 'argument outside project: /tmp/out', unallowable: true });
  expect(verdict('ls', BUILTIN_ALLOW, only({ text: 'ls', args: [], writes: [null] })).checks[0]!.why).toBe('argument not literal');
});

test('a built-in read-only command writing a file asks; a rule of the user allows it', () => {
  const writes = only({ text: 'cat a', args: ['a'], writes: ['b'] });
  expect(verdict('cat', BUILTIN_ALLOW, writes).checks[0]).toEqual({ text: 'cat a', action: 'ask', why: 'writes b', unallowable: false });
  expect(verdict('ls', BUILTIN_ALLOW, only({ text: 'ls', args: [], writes: ['/dev/null'] })).action).toBe('allow');
  expect(verdict('cat', [...BUILTIN_ALLOW, rule('cat *', 'allow', 'session')], writes).action).toBe('allow');
  expect(verdict('make', [rule('make *', 'allow')], only({ text: 'make', args: [], writes: ['log'] })).action).toBe('allow');
});

test('options making a built-in read-only command write or run something ask', () => {
  const asks = (command: string) => verdict(command).checks[0]!;
  expect(asks('find . -delete')).toEqual({ text: 'find . -delete', action: 'ask', why: 'may write: -delete', unallowable: false });
  for (const command of ['find . -exec rm {} +', 'find . -execdir x', 'find . -ok x', 'find . -okdir x', 'find . -fprint f', 'find . -fprint0 f', 'find . -fprintf f %p', 'find . -fls f']) expect(asks(command).action, command).toBe('ask');
  for (const command of ['sed -n -i s/a/b/ f', 'sed -n -Ei p f', 'sed -n --in-place s/a/b/ f', 'git diff --output=x', 'git log --output x', 'rg --pre=cat x', 'rg --pre cat x']) expect(asks(command).action, command).toBe('ask');
  for (const command of ['find . -name x', 'find . -executable', 'sed -n -E p f', 'git diff --output-indicator-new=x', 'rg --pretty x', 'grep -delete x', 'find . -name x-delete', 'sed -n s/a-i/b/ f', 'git log --x--output', 'rg a--pre']) expect(asks(command).action, command).toBe('allow');
  expect(verdict('find . -delete', [...BUILTIN_ALLOW, rule('find *', 'allow')]).action).toBe('allow');
  expect(verdict('find', BUILTIN_ALLOW, only({ text: ' find . -delete', args: ['.', '-delete'], writes: [] })).action).toBe('ask');
});

test('allow for session: the command prefix by the arity table, then " *"', () => {
  expect(prefixRule('git checkout -b feature')).toBe('git checkout *');
  expect(prefixRule('bun test src/a.test.ts')).toBe('bun test *');
  expect(prefixRule('npm run build -- --watch')).toBe('npm run build *');
  expect(prefixRule('docker compose up -d')).toBe('docker compose up *');
  expect(prefixRule('make')).toBe('make *');
  expect(prefixRule('rm -rf dist')).toBe('rm *');
  expect(prefixRule('git')).toBe('git *');
  expect(prefixRule('git   checkout  x')).toBe('git checkout *');
  expect(prefixRule('FOO=1 BAR=2 make build x')).toBe('FOO=1 BAR=2 make build *');
  expect(prefixRule('FOO=1 rm x')).toBe('FOO=1 rm *');
  expect(prefixRule('FOO=1')).toBe('FOO=1 *');
  expect(prefixRule('a.b=c x')).toBe('a.b=c *');
  expect(prefixRule('  python3   -m pytest')).toBe('python3 *');
});

test('the session rules for a call: one per sub-command asked for, without duplicates', () => {
  expect(sessionRules(verdict('rm a && ls && rm b && bun test'))).toEqual({ patterns: ['rm *', 'bun test *'] });
});

test('no session rule where an argument or the parse is why it asks', () => {
  const outside = verdict('cat', BUILTIN_ALLOW, only({ text: 'cat /x', args: ['/x'], writes: [] }));
  expect(sessionRules(outside)).toEqual({ error: 'cannot allow for session: argument outside project: /x – y runs once, e edits' });
  expect(sessionRules(verdict('echo "open'))).toEqual({ error: 'cannot allow for session: unparseable – y runs once, e edits' });
});

test('config rules: global ones in order, then the project ones, allow included', () => {
  expect(permissionRules({ 'git push *': 'ask', 'rm *': 'deny' }, { 'curl *': 'deny', 'git commit *': 'allow', 'make *': 'ask' })).toEqual([
    ...BUILTIN_ALLOW, rule('git push *', 'ask'), rule('rm *', 'deny'), rule('curl *', 'deny', 'project'), rule('git commit *', 'allow', 'project'), rule('make *', 'ask', 'project'),
  ]);
  expect(permissionRules(undefined, undefined)).toEqual(BUILTIN_ALLOW);
});

test('the session rules are the AllowRuleAdded events of the Session Log', () => {
  const rules = sessionAllowed([
    { type: 'SessionCreated', profile: 'default', protocol: 'native' },
    { type: 'AllowRuleAdded', pattern: 'make *' },
    { type: 'BlockAdded', id: 1, kind: 'User', origin: 'user', content: 'hi' },
    { type: 'AllowRuleAdded', pattern: 'bun test *' },
  ]);
  expect(rules).toEqual([rule('make *', 'allow', 'session'), rule('bun test *', 'allow', 'session')]);
});

test('patterns are shown quoted', () => {
  expect(quoted(['make *', 'rm *'])).toBe('"make *", "rm *"');
});
