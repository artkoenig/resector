import { expect, test } from 'bun:test';
import { subagentTools, toggleTool, TOOL_NAMES, TOOLS, toolNames } from './catalog';
import { QUESTION_DEFINITION } from './question';

const SEARCH = {
  name: 'websearch',
  description: expect.stringContaining('DuckDuckGo'),
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const BASH = {
  name: 'bash',
  description: expect.stringMatching(/project root.*With background: true it keeps running/),
  parameters: { type: 'object', properties: { command: { type: 'string' }, background: { type: 'boolean', description: expect.stringContaining('ends with the session') } }, required: ['command'] },
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

const SKILL = {
  name: 'skill',
  description:
    'Load a skill into the context by its name. The available skills and what they do are listed in the Skills note; ' +
    "call this with a skill's name to read its full instructions before doing the task it covers. " +
    'Its dependencies load with it.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: "the name of the skill to load" } }, required: ['name'] },
};

const IMAGE = {
  name: 'image',
  description:
    'Look at an image file (png, jpg, jpeg, gif, webp), e.g. a screenshot you took. The image is attached after the ' +
    'results of your tool calls.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'the image file, relative to the project root' } }, required: ['path'] },
};

const SUBAGENT = {
  name: 'subagent',
  description: expect.stringMatching(/Start a subagent.*`worktree`.*changes files.*uncommitted changes are not in it.*git merge/s),
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'the whole task, with all it needs to know' },
      worktree: { type: 'boolean', description: 'run it in a git worktree of its own, on a branch of its own' },
    },
    required: ['prompt'],
  },
};

test('a new Tools Block offers every tool: bash, websearch, question, skill, image and subagent', () => {
  expect(JSON.parse(TOOLS)).toEqual([BASH, SEARCH, QUESTION_TOOL, SKILL, IMAGE, SUBAGENT]);
  expect(QUESTION_DEFINITION.description).toContain('always a recommendation');
  expect(QUESTION_DEFINITION.description).toContain('never add an "Other" option');
  expect(toolNames(TOOLS)).toBe('bash, websearch, question, skill, image, subagent');
  expect(toolNames('[{"name":"a"},{"name":"b"}]')).toBe('a, b');
  expect(toolNames('[]')).toBe('no tools');
});

test('/tools switches a tool off and on again; an unknown one is refused', () => {
  const off = toggleTool(TOOLS, 'bash') as { content: string };
  expect(toolNames(off.content)).toBe('websearch, question, skill, image, subagent');
  expect(toggleTool(off.content, 'bash')).toEqual({ content: TOOLS });
  expect(toggleTool(TOOLS, 'python')).toEqual({ error: 'unknown tool python – bash websearch question skill image subagent' });
  expect(toggleTool(TOOLS, 'toString')).toEqual({ error: 'unknown tool toString – bash websearch question skill image subagent' });
});

test('/tools websearch switches websearch off; on again it sits after bash, with one query parameter', () => {
  const off = toggleTool(TOOLS, 'websearch') as { content: string };
  expect(JSON.parse(off.content)).toEqual([BASH, QUESTION_TOOL, SKILL, IMAGE, SUBAGENT]);
  expect(toggleTool(off.content, 'websearch')).toEqual({ content: TOOLS });
  expect(toggleTool('[]', 'websearch')).toEqual({ content: JSON.stringify([JSON.parse(TOOLS)[1]], null, 2) });
});

test('/tools image switches image off; on again it sits before subagent, with one path parameter', () => {
  const off = toggleTool(TOOLS, 'image') as { content: string };
  expect(JSON.parse(off.content)).toEqual([BASH, SEARCH, QUESTION_TOOL, SKILL, SUBAGENT]);
  expect(toggleTool(off.content, 'image')).toEqual({ content: TOOLS });
});

test('a Subagent is offered every tool asked for, all without any, but never `subagent`', () => {
  expect(subagentTools(undefined)).toEqual(['bash', 'websearch', 'question', 'skill', 'image']);
  expect(subagentTools(['bash', 'subagent'])).toEqual(['bash']);
  expect(subagentTools([])).toEqual([]);
  expect(TOOL_NAMES).toContain('subagent');
});

test('the subagent tool says what its Subagent does not know and that its result comes later', () => {
  const tool = JSON.parse(TOOLS).find((t: { name: string }) => t.name === 'subagent');
  expect(tool.parameters.required).toEqual(['prompt']);
  for (const said of ['does not know', 'prompt must hold everything', 'Note', 'sleep', 'stops its subagents']) expect(tool.description).toContain(said);
});
