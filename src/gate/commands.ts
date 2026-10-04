// The input line: slash commands, and text with @path references that becomes a User block and is sent.
import { references } from '../core/notes/files';
import { count } from './text';
import type { Kernel } from './kernel';
import type { View } from './types';

// Slash commands, in suggestion order.
export const COMMANDS = [
  { name: '/sessions', arg: '', description: 'list, resume, rename, delete sessions' },
  { name: '/rename', arg: '<title>', description: 'rename session' },
  { name: '/tools', arg: '<tool>', description: 'switch a tool on or off' },
  { name: '/filter', arg: '<kind>', description: 'show or hide blocks of a Kind' },
  { name: '/policy', arg: '<name>', description: 'switch a Context Policy on or off' },
  { name: '/auto', arg: '', description: 'switch auto-approve of Tool Calls on or off' },
  { name: '/thinking', arg: '<mode>', description: 'set thinking for the next requests' },
  { name: '/git:branch', arg: '<branch>', description: 'show or switch the git branch' },
  { name: '/git:worktree', arg: '<on|off>', description: 'run the session in its own git worktree' },
] as const;
export type CommandName = (typeof COMMANDS)[number]['name'];

// `inRepo`: the /git: commands are offered only in a git repository.
export function createCommands(k: Kernel, sel: View, handlers: Record<CommandName, (arg: string) => void>, deps: { inRepo: boolean; send: () => void }) {
  const { nextId, append, setStatus } = k;
  // The commands offered: the /git: ones only in a git repository.
  const offered = COMMANDS.filter(c => deps.inRepo || !c.name.startsWith('/git:'));

  // Input text: a known command runs with the rest as argument; an unknown `/word` is an error; anything else becomes
  // a User block and is sent right away – if sending is blocked, the block stays and the status says why.
  function submit(text: string) {
    const name = text.trim().split(/\s/)[0]!;
    if (offered.some(c => c.name === name)) handlers[name as CommandName](text.trim().slice(name.length).trim());
    else if (/^\/[\w:]+$/.test(name)) setStatus({ text: `unknown command ${name}: ${offered.map(c => c.name).join(' ')}`, tone: 'error' });
    else if (text.trim()) addInput(text);
  }
  // `@path` references become rows of their own before the text; only a text is sent right away.
  function addInput(input: string) {
    const { files, text } = references(input);
    for (const file of files) {
      const id = nextId();
      append({ type: 'FileReferenced', id, file });
      sel.setSelected(id);
    }
    if (text) {
      addUser(text);
      deps.send();
    } else setStatus({ text: `${count(files.length, 'file reference')} added – read at send · e opens the file · Enter sends`, tone: 'info' });
  }
  function addUser(content: string) {
    const id = nextId();
    append({ type: 'BlockAdded', id, kind: 'User', origin: 'user', content });
    sel.release();
    sel.setSelected(id);
  }

  return { api: { commands: offered, submit } };
}
