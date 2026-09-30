import { expect, test } from 'bun:test';
import { DEFAULT_MODES, probedModes, thinkingModes } from './template';

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

test('effort lists and comparisons are found however they are spaced; unknown efforts come last', () => {
  expect(thinkingModes(`{% if reasoning_effort  not  in ('high', 'low') %}`)).toEqual(['low', 'high']);
  expect(thinkingModes(`{% if reasoning_effort in('turbo', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none') %}`))
    .toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo']);
  expect(thinkingModes(`{% if reasoning_effort=='low' %}`)).toEqual(['low']);
});

test('an unknown chat template: only off and on, no guessed efforts', () => {
  expect(DEFAULT_MODES).toEqual(['off', 'on']);
});

// Prompts in RANK order: none, minimal, low, medium, high, xhigh, max.
test('probed: efforts rendering alike are one mode, named as the prompt names it; none apart is off and on', () => {
  const think = (effort: string) => `system: Reasoning effort is set to ${effort}.\n<think>`;
  const prompts = ['<think></think>', think('low'), think('low'), '<think>', think('xhigh'), think('xhigh'), think('xhigh')];
  expect(probedModes(prompts)).toEqual(['off', 'on', 'low', 'medium', 'xhigh']);
});

test('probed: refused efforts are left out; all alike or none rendered: no mode', () => {
  expect(probedModes([null, null, 'a', null, 'b', null, null])).toEqual(['low', 'high']);
  expect(probedModes(Array(7).fill('same'))).toEqual([]);
  expect(probedModes(Array(7).fill(null))).toEqual([]);
});
