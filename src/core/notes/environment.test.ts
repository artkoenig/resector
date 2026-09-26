import { expect, test } from 'bun:test';
import type { SessionEvent } from '../log/events';
import { fold } from '../log/fold';
import { newSession } from '../session/session';
import { environmentText, refreshEnvironment } from './environment';

const env = { cwd: '/p', os: 'linux x64', shell: 'bash', date: '2026-09-26', branch: 'main' };
const text = environmentText(env);

test('the environment Note holds cwd, OS and shell, date and git branch (FR-28)', () => {
  expect(text).toBe('cwd: /p\nos: linux x64 · shell: bash\ndate: 2026-09-26\ngit branch: main');
  expect(environmentText({ ...env, branch: null })).toBe('cwd: /p\nos: linux x64 · shell: bash\ndate: 2026-09-26\ngit branch: (none)');
});

const start = newSession('qwen', 'sys', { environment: text });
const refresh = (events: SessionEvent[], now: string) => refreshEnvironment(events, fold(events), now);
const tomorrow = environmentText({ ...env, date: '2026-09-27' });

test('an unchanged environment adds no Revision', () => {
  expect(refresh(start, text)).toBeNull();
  expect(refresh([...start, { type: 'BlockAdded', id: 4, kind: 'User', origin: 'user', content: 'hi' }], text)).toBeNull();
});

test('a changed environment is a new Revision by the harness', () => {
  const changed = refresh(start, tomorrow);
  expect(changed).toEqual({ type: 'Edit', id: 3, revision: 2, content: tomorrow, harness: true });
  expect(refresh([...start, changed!], tomorrow)).toBeNull();
});

test('a user edit stays until the environment itself changes', () => {
  const edited: SessionEvent[] = [...start, { type: 'Edit', id: 3, revision: 2, content: 'cwd: /p' }];
  expect(refresh(edited, text)).toBeNull();
  expect(refresh(edited, tomorrow)).toEqual({ type: 'Edit', id: 3, revision: 3, content: tomorrow, harness: true });
});

test('a removed environment Note, or none, is not refreshed', () => {
  expect(refresh([...start, { type: 'Remove', id: 3 }], tomorrow)).toBeNull();
  expect(refresh(newSession('qwen', 'sys'), tomorrow)).toBeNull();
});
