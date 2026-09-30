// Suggestions above the input: commands, their values and @path completions, the one chosen, and their lines.
import { createMemo, createSignal, For } from 'solid-js';
import { basename } from 'node:path';
import { fileCompletions } from '../core/notes/files';
import { TOOL_NAMES } from '../core/toolcall/bash';
import type { Screen } from './screen';
import { FILTERS } from './selection';
import type { Mode } from './prompt';
import { ACCENT, MUTED, SELECTED_BG, TEXT } from './theme';

// A line above the input: Tab puts `draft` into it; Enter runs `run`, or (null) completes as Tab does.
export type Suggestion = { label: string; description: string; draft: string; run: string | null };

export function createSuggestions(gate: Screen, draft: () => string, mode: () => Mode, files: () => string[]) {
  const [suggested, setSuggested] = createSignal(0);
  // Commands while the draft is a single `/word`, the tools after `/tools `, the filter values after `/filter `, the policies after `/policy `, project files while an @path
  // is typed at its end. Tab completes; Enter runs a command taking no argument, else completes too.
  const suggestions = createMemo((): Suggestion[] => {
    if (mode() !== 'input') return [];
    if (/^\/\S*$/.test(draft())) {
      return gate.commands.filter(c => c.name.startsWith(draft())).map(c => ({
        label: `${c.name} ${c.arg}`, description: c.description, draft: c.name + (c.arg ? ' ' : ''), run: c.arg && draft() !== c.name ? null : c.name,
      }));
    }
    const tool = /^\/tools (\S*)$/.exec(draft());
    if (tool) {
      return TOOL_NAMES.filter(name => name.startsWith(tool[1]!)).map(name => ({
        label: name, description: gate.toolsOn().includes(name) ? 'on → off' : 'off → on', draft: `/tools ${name}`, run: `/tools ${name}`,
      }));
    }
    const value = valueSuggestions(draft());
    if (value) return value;
    const found = fileCompletions(draft(), files());
    return found ? found.paths.map(path => ({ label: path, description: '', draft: `${draft().slice(0, found.at)}${path} `, run: null })) : [];
  });
  // The values after `/filter `, `all` first while one is off, `/policy `, `off` first while one is on, `/thinking `
  // and the /git: commands; null for any other draft.
  function valueSuggestions(text: string): Suggestion[] | null {
    const [, command, typed] = /^\/(filter|policy|thinking|git:branch|git:worktree) (\S*)$/.exec(text) ?? [];
    if (!command || !gate.commands.some(c => c.name === `/${command}`)) return null;
    const values = { filter: filterValues, policy: policyValues, thinking: thinkingValues, 'git:branch': branchValues, 'git:worktree': worktreeValues }[command]!();
    return values
      .filter(v => v.name.toLowerCase().startsWith(typed!.toLowerCase()))
      .map(v => ({ label: v.name, description: v.description, draft: `/${command} ${v.name}`, run: `/${command} ${v.name}` }));
  }
  const filterValues = () => [
    ...(gate.hidden().length ? [{ name: 'all', description: 'show all blocks' }] : []),
    ...FILTERS.map(f => ({ name: f.name, description: `${gate.hidden().includes(f) ? 'off' : 'on'} · ${f.kinds.join(' + ')}` })),
  ];
  const policyValues = () => [
    ...(gate.policy() ? [{ name: 'off', description: 'no policy' }] : []),
    ...gate.policyNames().map(name => {
      const about = gate.policyDescription(name);
      return { name, description: name === gate.policy() ? (about ? `active · ${about}` : 'active') : (about ?? 'switch on') };
    }),
  ];
  const thinkingValues = () => gate.thinkingOptions().map(o => ({ name: o.name, description: o.value === gate.thinking() ? 'active' : 'switch on' }));
  // Branches in another worktree last: git refuses to switch to them.
  const branchValues = () =>
    gate
      .branches()
      .sort((a, b) => Number(!!a.elsewhere) - Number(!!b.elsewhere))
      .map(({ name, elsewhere }) => ({
      name,
      description: name === gate.branch() ? 'current' : elsewhere ? `in worktree ${basename(elsewhere)}` : 'switch to',
    }));
  const worktreeValues = () =>
    gate.worktree() ? [{ name: 'off', description: 'run in the project directory, keep the worktree' }] : [{ name: 'on', description: 'run in .resector/worktrees/<session>' }];
  const chosen = () => Math.min(suggested(), suggestions().length - 1);
  return {
    suggestions,
    chosen,
    suggestion: () => suggestions()[chosen()],
    // ↑↓ cycle through the suggestions.
    move: (step: number) => setSuggested((suggested() + suggestions().length + step) % suggestions().length),
    // A changed draft starts at the first suggestion.
    reset: () => setSuggested(0),
  };
}

export function Suggestions(props: { suggestions: Suggestion[]; chosen: number }) {
  return (
    <For each={props.suggestions}>
      {(s, i) => (
        <text flexShrink={0} bg={i() === props.chosen ? SELECTED_BG : undefined}>
          <span style={{ fg: i() === props.chosen ? ACCENT : TEXT }}>{`  ${s.label.padEnd(22)} `}</span>
          <span style={{ fg: MUTED }}>{s.description}</span>
        </text>
      )}
    </For>
  );
}
