// Session settings switched by slash commands: /thinking, /rename, /tools, /filter, /auto.
import type { Thinking } from '../../core/log/events';
import * as ops from '../../core/context/operations';
import { DEFAULT_MODES } from '../../core/render/template';
import { thinkingLabel } from '../format';
import type { Kernel } from './kernel';
import type { Rules } from './rules';
import { FILTERS, type Selection } from './selection';
import type { ToolLoop } from './tool-loop';
import type { AutoApprove } from './types';

export function createSettings(k: Kernel, sel: Selection, rules: Rules, loop: ToolLoop, autoApprove: AutoApprove) {
  const { context, backend, append, setStatus, toolsOn } = k;

  // Thinking for the following requests: the one set at the Gate, else the Model Profile's.
  const thinking = (): Thinking => context().thinking ?? backend().thinking ?? 'off';
  // The modes of the model's chat template, as the backend read them when it connected (session opened, setup).
  const thinkingModes = () => backend().thinkingModes ?? DEFAULT_MODES;
  // The options /thinking offers: `on` only when no efforts exist (edge case), otherwise the efforts with their labels.
  const thinkingOptions = () => {
    const modes = thinkingModes();
    const hasEfforts = modes.some(m => m !== 'off' && m !== 'on');
    const filtered = hasEfforts ? modes.filter(m => m !== 'on') : modes;
    return filtered.map(m => ({ name: thinkingLabel(m), value: m }));
  };
  function setThinking(arg: string) {
    const options = thinkingOptions();
    if (!options.length) return setStatus({ text: 'the chat template has no thinking switch', tone: 'info' });
    if (!arg) return setStatus({ text: `thinking ${thinkingLabel(thinking())} · /thinking ${options.map(o => o.name).join(' ')}`, tone: 'info' });
    const match = options.find(o => o.name === arg);
    if (!match) return setStatus({ text: `unknown thinking ${arg}: ${options.map(o => o.name).join(' ')}`, tone: 'error' });
    append({ type: 'ThinkingSet', thinking: match.value });
    setStatus({ text: `thinking ${thinkingLabel(match.value)}`, tone: 'info' });
  }

  function renameSession(title: string) {
    append({ type: 'SessionRenamed', title });
    setStatus({ text: title ? `session renamed: ${title}` : 'session title reset to the first User message', tone: 'info' });
  }

  function toggleTool(name: string) {
    if (!name) return setStatus({ text: `tools: ${toolsOn().join(', ') || 'none'} · /tools <tool> switches one`, tone: 'info' });
    if (!k.apply(ops.toggleTool(k.events(), context(), name, rules.denied()))) return;
    setStatus({ text: `${name} ${toolsOn().includes(name) ? 'on' : 'off'} · u = undo`, tone: 'info' });
  }

  // /filter <kind> switches that Kind Filter on or off, /filter all shows every block; alone it lists them.
  // Marks on blocks now hidden are cleared: none stay hidden.
  function filterBy(name: string) {
    const { hidden, setHidden } = sel;
    const values = `all ${FILTERS.map(f => f.name).join(' ')}`;
    const state = FILTERS.map(f => `${f.name} ${hidden().includes(f) ? 'off' : 'on'}`).join(', ');
    if (!name) return setStatus({ text: `filter: ${state} · /filter ${values}`, tone: 'info' });
    const chosen = FILTERS.find(f => f.name === name.toLowerCase());
    if (name.toLowerCase() === 'all') setHidden([]);
    else if (!chosen) return setStatus({ text: `unknown filter ${name}: ${values}`, tone: 'error' });
    else setHidden(hidden().includes(chosen) ? hidden().filter(f => f !== chosen) : FILTERS.filter(f => f === chosen || hidden().includes(f)));
    sel.setMarked(new Set([...sel.marked()].filter(id => sel.shown().includes(id))));
  }

  // /auto switches auto-approve on or off; a call awaiting approval then runs at once.
  function switchAutoApprove() {
    autoApprove.set(!autoApprove.on());
    const text = autoApprove.on() ? 'auto-approve on – Tool Calls run without asking, deny rules still apply' : 'auto-approve off';
    const call = ops.nextCall(context());
    if (autoApprove.on() && call && call.tool !== 'question' && !k.running() && !k.streaming()) return loop.advance([text]);
    setStatus({ text, tone: 'info' });
  }

  return { thinking, thinkingOptions, setThinking, renameSession, toggleTool, filterBy, switchAutoApprove };
}
