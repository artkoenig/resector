// PROTOTYPE (throwaway, #110): how a Headless Run looks in the terminal – --show kinds on stderr, Question and
// Tool Approval asked on the terminal, the final answer on stdout. Scripted run, no model, no tools.
// bun src/cli/show.prototype.ts <a|b|c> [--show thinking,tools,notes,policy|all] [--no-color]
// Try: … 2>/dev/null (stdout only), … >/dev/null (stderr only).
const args = process.argv.slice(2);
const variant = (args.find(a => /^[abc]$/.test(a)) ?? 'a') as 'a' | 'b' | 'c';
const showArg = args[args.indexOf('--show') + 1];
const show = new Set(args.includes('--show') ? (showArg === 'all' ? ['thinking', 'tools', 'notes', 'policy'] : showArg!.split(',')) : []);
const color = !args.includes('--no-color') && process.stderr.isTTY;
const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2'), bold = c('1'), yellow = c('33'), cyan = c('36'), green = c('32'), red = c('31'), magenta = c('35');
const err = (s = '') => process.stderr.write(s + '\n');
const sleep = (ms: number) => Bun.sleep(ms);
const ask = (q: string) => (prompt(q) ?? '').trim();

// The scripted run.
const THINKING = 'The user asks why the test fails. Let me run it first and look at the error, then find the cause in the source.';
const CALL1 = 'bun test src/core/tokens/split.test.ts';
const RESULT1 = ['bun test v1.3.0', '', 'src/core/tokens/split.test.ts:', '✓ splits system and tools [0.4ms]', '✗ counts the template once [1.2ms]',
  '  expect(received).toBe(expected)', '  Expected: 12', '  Received: 24', '      at split.test.ts:41:23', '', ' 1 pass', ' 1 fail', 'Ran 2 tests across 1 file. [18ms]'];
const CALL2 = "sed -i '' 's/template \\+ template/template/' src/core/tokens/split.ts && bun test src/core/tokens/split.test.ts";
const CHECKS = [
  { text: "sed -i '' 's/…/…/' src/core/tokens/split.ts", action: 'ask', why: 'no rule → default ask' },
  { text: 'bun test src/core/tokens/split.test.ts', action: 'allow', why: 'global rule "bun test *"' },
];
const QUESTION = { q: 'Fix the double count in split.ts or only adjust the test expectation?', options: ['Fix split.ts (Recommended)', 'Adjust the test'] };
const POLICY = 'summary-reset: 2 blocks compacted (Tool Pair bun test → Note) · 1.8k tokens freed';
const ANSWER = 'The test fails because `split()` adds the chat template twice (`template + template`, split.ts:57).\nI fixed it to count the template once; `bun test src/core/tokens/split.test.ts` now passes (2 pass, 0 fail).\n';

// ── Variant A: log lines – one prefixed line per event, results cut to 3 lines.
const A = {
  thinking: async () => { if (show.has('thinking')) err(dim(`∴ ${THINKING}`)); },
  call: (cmd: string) => { if (show.has('tools')) err(`${cyan('$')} ${cmd}`); },
  result: (lines: string[], exit: number) => {
    if (!show.has('tools')) return;
    lines.slice(0, 3).forEach(l => err(dim(`  │ ${l}`)));
    if (lines.length > 3) err(dim(`  │ … ${lines.length - 3} more lines`));
    err(dim(`  └ exit ${exit}`));
  },
  approval: () => {
    err(`${yellow('?')} ${bold('approve')} ${CALL2}`);
    CHECKS.forEach(k => err(`  ${k.action === 'allow' ? green('✓') : yellow('?')} ${k.text} ${dim(`(${k.why})`)}`));
    return ask(`  ${yellow('y')} run once · ${yellow('a')} allow for session · ${yellow('n')} reject › `);
  },
  question: () => {
    err(`${magenta('?')} ${bold(QUESTION.q)}`);
    QUESTION.options.forEach((o, i) => err(`  ${i + 1}. ${o}`));
    return ask(`  number, or your own answer (empty: recommended, - skip) › `);
  },
  note: () => { if (show.has('policy')) err(dim(`◆ ${POLICY}`)); },
  status: (s: string) => err(dim(`· ${s}`)),
};

// ── Variant B: blocks – a header line per Context Block like the Gate's rows, content indented, results cut to 8 lines.
const header = (kind: string, title: string) => err(`${dim('──')} ${bold(kind)} ${dim(title)} ${dim('─'.repeat(Math.max(2, 50 - kind.length - title.length)))}`);
const B = {
  thinking: async () => {
    if (!show.has('thinking')) return;
    header('Thinking', '');
    for (const word of THINKING.split(' ')) { process.stderr.write(dim(word + ' ')); await sleep(15); }
    err();
  },
  call: (cmd: string) => { if (show.has('tools')) { header('Tool Call', 'bash'); err(`  ${cmd}`); } },
  result: (lines: string[], exit: number) => {
    if (!show.has('tools')) return;
    header('Tool Result', `exit ${exit} · ${lines.length} lines`);
    lines.slice(0, 8).forEach(l => err(`  ${l}`));
    if (lines.length > 8) err(dim(`  … ${lines.length - 8} more`));
  },
  approval: () => {
    header('Tool Approval', 'bash');
    err(`  ${CALL2}`);
    CHECKS.forEach(k => err(`  ${k.action === 'allow' ? green('allow') : yellow('ask  ')} ${k.text}  ${dim(k.why)}`));
    return ask(`  [y] run once  [a] allow for session  [n] reject  [e] edit › `);
  },
  question: () => {
    header('Question', '');
    err(`  ${QUESTION.q}`);
    QUESTION.options.forEach((o, i) => err(`   ${i + 1}) ${o}`));
    return ask(`  answer [1]: `);
  },
  note: () => { if (show.has('policy')) { header('Note', 'Context Policy'); err(`  ${POLICY}`); } },
  status: (s: string) => err(dim(`  ${s}`)),
};

// ── Variant C: quiet – one live status line (TTY), shown kinds as single lines above it; asking clears it.
let live = '';
const setLive = (s: string) => { if (!process.stderr.isTTY) { if (s && !/^[⠋⠙]/.test(s)) err(s); return; } live = s; process.stderr.write(`\r\x1b[2K${dim(s)}`); };
const above = (s: string) => { if (!process.stderr.isTTY) return err(s); process.stderr.write('\r\x1b[2K'); err(s); if (live) process.stderr.write(dim(live)); };
const C = {
  thinking: async () => { setLive('⠋ thinking…'); await sleep(400); if (show.has('thinking')) above(dim(`thinking: ${THINKING.slice(0, 70)}…`)); },
  call: (cmd: string) => { setLive(`⠙ running ${cmd.slice(0, 50)}`); if (show.has('tools')) above(`${cyan('▶')} ${cmd}`); },
  result: (lines: string[], exit: number) => { if (show.has('tools')) above(dim(`  ${exit ? red('✗') : green('✓')} exit ${exit} · ${lines.length} lines · ${lines.find(l => /fail|✗/.test(l))?.trim() ?? lines.at(-1)}`)); },
  approval: () => {
    setLive('');
    above(`${yellow('approve?')} ${CALL2}`);
    CHECKS.filter(k => k.action !== 'allow').forEach(k => above(dim(`  asks: ${k.text} – ${k.why}`)));
    return ask(`${yellow('y/a/n')} › `);
  },
  question: () => {
    setLive('');
    above(`${magenta('question:')} ${QUESTION.q}`);
    return ask(`${QUESTION.options.map((o, i) => `${i + 1}=${o}`).join('  ')} › `);
  },
  note: () => { if (show.has('policy')) above(dim(`policy: ${POLICY}`)); },
  status: (s: string) => setLive(s),
};

const v = { a: A, b: B, c: C }[variant];
const tty = !!process.stdin.isTTY;
await v.thinking();
v.call(CALL1);
await sleep(300);
v.result(RESULT1, 1);
const answer = tty ? v.question() : (v.status('question declined – no terminal'), '');
const approved = tty ? v.approval() : (v.status('not run: no user to approve'), 'n');
if (approved === 'y' || approved === 'a') {
  v.call(CALL2);
  await sleep(300);
  v.result(['bun test v1.3.0', '', ' 2 pass', ' 0 fail', 'Ran 2 tests across 1 file. [17ms]'], 0);
}
v.note();
if (variant === 'c' && process.stderr.isTTY) { process.stderr.write('\r\x1b[2K'); live = ''; }
v.status(`answer complete · 4 turns · 3.1k tokens · ${answer ? `answered "${answer}"` : 'no answer'}`);
if (variant === 'c' && process.stderr.isTTY) err();
process.stdout.write(ANSWER);
export {};
