// Tests for drawing Mermaid blocks in the preview.
import { expect, test } from 'bun:test';
import { drawMermaid } from './mermaid';

test('a mermaid block becomes a plain code block with the diagram', () => {
  const out = drawMermaid('before\n```mermaid\ngraph LR\n  A --> B\n```\nafter');
  expect(out).toStartWith('before\n```\n');
  expect(out).toEndWith('\n```\nafter');
  expect(out).toContain('┌');
  expect(out).not.toContain('graph LR');
});

test('a block that does not parse stays as written', () => {
  const md = '```mermaid\nnot a diagram\n```';
  expect(drawMermaid(md)).toBe(md);
});

test('markdown without mermaid is unchanged', () => {
  const md = '# title\n```ts\nconst a = 1;\n```';
  expect(drawMermaid(md)).toBe(md);
});
