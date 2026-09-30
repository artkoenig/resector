import { expect, test } from 'bun:test';
import { toggleTool, TOOLS, toolNames } from './catalog';
import { QUESTION_DEFINITION } from './question';

const SEARCH = {
  name: 'search',
  description: expect.stringContaining('DuckDuckGo'),
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const BASH = {
  name: 'bash',
  description: expect.stringContaining('project root'),
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};

const OPTION = { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label', 'description'] };
const QUESTION_TOOL = {
  name: 'question',
  description: expect.stringContaining('`recommended` is the label of the option you advise'),
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'the full question' },
            header: { type: 'string', description: 'a very short label' },
            options: { type: 'array', minItems: 2, items: OPTION },
            multiple: { type: 'boolean', description: 'several options may be chosen' },
            recommended: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'label(s) of the recommended option(s)' },
          },
          required: ['question', 'header', 'options', 'recommended'],
        },
      },
    },
    required: ['questions'],
  },
};

test('a new Tools Block offers bash with one command parameter and question', () => {
  expect(JSON.parse(TOOLS)).toEqual([BASH, QUESTION_TOOL]);
  expect(QUESTION_DEFINITION.description).toContain('always a recommendation');
  expect(QUESTION_DEFINITION.description).toContain('never add an "Other" option');
  expect(toolNames(TOOLS)).toBe('bash, question');
  expect(toolNames('[{"name":"a"},{"name":"b"}]')).toBe('a, b');
  expect(toolNames('[]')).toBe('no tools');
});

test('/tools switches a tool off and on again; an unknown one is refused', () => {
  const off = toggleTool(TOOLS, 'bash') as { content: string };
  expect(toolNames(off.content)).toBe('question');
  expect(toggleTool(off.content, 'bash')).toEqual({ content: TOOLS });
  expect(toggleTool(TOOLS, 'python')).toEqual({ error: 'unknown tool python – bash search question' });
  expect(toggleTool(TOOLS, 'toString')).toEqual({ error: 'unknown tool toString – bash search question' });
});

test('/tools search switches search on after bash, with one query parameter; off again, bash stays', () => {
  const on = toggleTool(TOOLS, 'search') as { content: string };
  expect(JSON.parse(on.content)).toEqual([BASH, SEARCH, QUESTION_TOOL]);
  expect(toolNames(on.content)).toBe('bash, search, question');
  expect(toggleTool('[]', 'search')).toEqual({ content: JSON.stringify([JSON.parse(on.content)[1]], null, 2) });
  expect(toggleTool(on.content, 'search')).toEqual({ content: TOOLS });
});
