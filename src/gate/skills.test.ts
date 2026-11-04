// Loading Skills at the Gate: where the Notes go in the Context, what is told about them, /skill.
import { expect, test } from 'bun:test';
import type { Skill } from '../core/skills/skills';
import { toolsWith } from '../core/tools/catalog';
import { bash, gateWith, results, settled } from './gate.harness';

const named = (name: string, requires: string[] = []): Skill => ({ name, description: '', file: `/skills/${name}/SKILL.md`, body: `${name} body`, requires, files: [] });
const skillCall = (name: string) => ({ name: 'skill', arguments: JSON.stringify({ name }) });
const setup = (...skills: Skill[]) => gateWith({ tools: toolsWith(['bash', 'skill']), global: { 'ls*': 'allow' }, skills });
const kinds = (g: ReturnType<typeof gateWith>) => g.gate.context().blocks.slice(2).map(b => b.skill ?? b.kind);

test('a skill call after another call: its Notes follow all calls and results of the answer, in order', async () => {
  const g = setup(named('a', ['b']), named('b'));
  g.reply({ calls: [bash('ls'), skillCall('a')] }, { content: 'done' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(kinds(g)).toEqual(['User', 'Tool Call', 'Tool Call', 'Tool Result', 'Tool Result', 'a', 'b', 'Assistant']);
});

test('a skill call before another call does not split the answer', async () => {
  const g = setup(named('a'));
  g.reply({ calls: [skillCall('a'), bash('ls')] }, { content: 'done' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(kinds(g)).toEqual(['User', 'Tool Call', 'Tool Call', 'Tool Result', 'Tool Result', 'a', 'Assistant']);
});

test('a skill requiring itself twice loads once', async () => {
  const g = setup(named('a', ['a', 'a']));
  g.reply({ calls: [skillCall('a')] }, { content: 'done' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(g.gate.context().blocks.filter(b => b.skill)).toHaveLength(1);
});

test('the Tool Result names only what was loaded', async () => {
  const g = setup(named('a', ['b']), named('b'));
  g.gate.submit('/skill b');
  g.reply({ calls: [skillCall('a')] }, { calls: [skillCall('a')] }, { content: 'done' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(results(g.events).map(r => r.content)).toEqual(['loaded a\n[exit 0]', 'already loaded: a\n[exit 0]']);
});

test('an unknown skill is a failed Tool Result and loads nothing', async () => {
  const g = setup(named('a'));
  g.reply({ calls: [skillCall('nope')] }, { content: 'done' });
  g.gate.submit('go');
  await settled(g.gate);
  expect(results(g.events)[0]!.content).toBe('unknown skill: nope\n[exit 1]');
  expect(g.gate.context().blocks.filter(b => b.skill)).toEqual([]);
});

test('/skill <name> adds the skill and what it requires at the end, once', () => {
  const g = setup(named('a', ['b']), named('b'));
  g.gate.submit('/skill a');
  expect(g.gate.status()).toMatchObject({ text: 'loaded a, b', tone: 'ok' });
  expect(kinds(g)).toEqual(['a', 'b']);
  g.gate.submit('/skill a');
  expect(g.gate.status()).toMatchObject({ text: 'already loaded: a', tone: 'ok' });
  expect(kinds(g)).toEqual(['a', 'b']);
});

test('/skill alone lists the skills, an unknown name is an error', () => {
  const g = setup(named('a'), named('b'));
  expect(g.gate.skillNames()).toEqual(['a', 'b']);
  g.gate.submit('/skill');
  expect(g.gate.status()).toMatchObject({ text: 'skills: a, b', tone: 'info' });
  g.gate.submit('/skill nope');
  expect(g.gate.status()).toMatchObject({ text: 'unknown skill nope: a b', tone: 'error' });
});

test('/skill without any skills says so', () => {
  const g = setup();
  g.gate.submit('/skill');
  expect(g.gate.status()).toMatchObject({ text: 'no skills found', tone: 'info' });
});
