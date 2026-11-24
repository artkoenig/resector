import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackground } from './background';
import { dropReport, readReport, writeReport } from './report';

const temp = () => mkdtempSync(join(tmpdir(), 'resector-report-'));

test('the last report written is the one read; a missing, dropped or broken one is none', () => {
  const dir = temp();
  expect(readReport(dir, 7)).toEqual({});
  writeReport(dir, 7, { session: 'ses_a', turns: 1, tokens: 10 });
  writeReport(dir, 7, { session: 'ses_a', turns: 2, tokens: 20, outcome: 'answer', text: 'done' });
  expect(readReport(dir, 7)).toEqual({ report: { session: 'ses_a', turns: 2, tokens: 20, outcome: 'answer', text: 'done' } });
  expect(readdirSync(dir)).toEqual(['7.report.json']);
  for (const broken of ['{"turns": 2, "te', 'null', '{"turns":2}']) {
    writeFileSync(join(dir, '7.report.json'), broken);
    expect(readReport(dir, 7)).toEqual({});
  }
  dropReport(dir, 7);
  dropReport(dir, 7);
  expect(readdirSync(dir)).toEqual([]);
});

test('a process\'s end carries the report it left', async () => {
  const dir = temp();
  const registry = createBackground({ dir, record: join(dir, 'ses.background') });
  const ends: unknown[] = [];
  registry.onExit((_, end) => ends.push(end));
  const run = (command: string) => registry.start(command, { cwd: dir, wait: 5, signal: new AbortController().signal, env: { REPORTS: dir } });
  await run(`sleep 0.2; echo '{"turns":1,"tokens":5,"outcome":"answer"}' > "$REPORTS/$$.report.json"`);
  await run('true');
  expect(ends).toEqual([{ exit: 0, report: { turns: 1, tokens: 5, outcome: 'answer' } }, { exit: 0 }]);
});
