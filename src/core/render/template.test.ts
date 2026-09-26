import { expect, test } from 'bun:test';
import { thinkingModes } from './template';

test('a template with enable_thinking and a checked effort list offers off, on and its efforts, lowest first (FR-49)', () => {
  const template = `{%- if enable_thinking is defined and enable_thinking is false %}…{%- endif %}
{%- set resolved_reasoning_effort = reasoning_effort|default('low') %}
{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}{{ raise_exception('bad') }}{%- endif %}`;
  expect(thinkingModes(template)).toEqual(['off', 'on', 'low', 'medium', 'xhigh']);
});

test('efforts only compared with: those; no enable_thinking: no off and on', () => {
  const template = `{%- if reasoning_effort == 'high' %}Reasoning: high{% elif reasoning_effort == "low" %}Reasoning: low{% else %}Reasoning: medium{% endif %}`;
  expect(thinkingModes(template)).toEqual(['low', 'high']);
});

test('a template without thinking offers no mode', () => {
  expect(thinkingModes('{{ messages }}')).toEqual([]);
  expect(thinkingModes('{%- if enable_thinking %}<think>{% endif %}')).toEqual(['off', 'on']);
});
