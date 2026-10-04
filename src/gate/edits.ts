// Context operations on the selected or marked blocks: move, remove, undo, edit, mark, copy.
import { createSignal } from 'solid-js';
import * as ops from '../core/context/operations';
import type { SessionEvent } from '../core/log/events';
import { pairOf, type Block } from '../core/log/fold';
import { parseReference } from '../core/notes/files';
import { errorText } from './text';
import type { Kernel } from './kernel';
import type { ToolLoop } from './tool-loop';
import type { Project, View } from './types';
import type { Clipboard, Editor } from './ports';

// Undone operations whose event type does not read as one.
const UNDONE: Partial<Record<SessionEvent['type'], string>> = { PairToNote: 'Tool Pair → Note' };

export function createEdits(k: Kernel, sel: View, loop: ToolLoop, deps: { editor: Editor; clipboard: Clipboard; project: Project }) {
  const { context, events, nextId, apply, setStatus, blockOf } = k;
  const { selectedBlock, setSelected, shown, marked, setMarked } = sel;
  // Moving a Tool Pair asks first: the operation and block awaiting the same key again.
  const [confirming, setConfirming] = createSignal<string | null>(null);

  // A Context operation on the selected block; `describe` gives the status line text afterwards.
  function operate(operation: (block: Block) => ops.Outcome, describe: (block: Block) => string | null) {
    const block = selectedBlock();
    if (!block || !apply(operation(block))) return;
    const text = describe(block);
    setStatus(text ? { text, tone: 'info' } : null);
  }

  // A Tool Pair is moved as a Note: the first press asks, the same key again converts it,
  // then the operation acts on the Note. `action` names the operation, `key` its key.
  function viaNote(action: string, key: string, then: () => void) {
    const block = selectedBlock();
    if (!block || !ops.inPair(block)) return then();
    const asked = `${action} ${block.id}`;
    if (confirming() !== asked) {
      setConfirming(asked);
      return setStatus({ text: `⇄ This turns the Tool Pair into a Note – press ${key} again to confirm, any other key cancels`, tone: 'warn' });
    }
    setConfirming(null);
    const id = nextId();
    if (!apply(ops.toNote(block, id))) return;
    setSelected(id);
    then();
  }
  function move(dir: -1 | 1) {
    if (sel.hiding()) return;
    viaNote(`move ${dir}`, dir < 0 ? '⌥↑' : '⌥↓', () => operate(b => ops.move(context(), b, dir), () => null));
  }
  const whole = (b: Block) => (ops.inPair(b) ? ' (whole Tool Pair)' : '');
  // d: the marked blocks, else the selected one.
  function remove() {
    const at = shown().indexOf(sel.selected());
    if (marked().size) removeMarked();
    else operate(ops.remove, b => `removed${whole(b)} · struck through until sent · u = undo`);
    setMarked(new Set([...marked()].filter(id => k.sent().some(b => b.id === id))));
    sel.selectAt(at);
  }
  function removeMarked() {
    const blocks = context().blocks.filter(b => marked().has(b.id));
    if (!apply(ops.removeAll(blocks))) return;
    setStatus({ text: `removed ${blocks.length} marked blocks · struck through until sent · u = undo`, tone: 'info' });
    setMarked(new Set<number>());
  }
  function undo() {
    const result = ops.undo(events());
    if ('error' in result) return apply(result);
    const { type } = events()[result.event.eventId]!;
    apply(result);
    sel.keepSelection();
    setStatus({ text: `undone: ${UNDONE[type] ?? type.toLowerCase()} (counter-event in Session Log)`, tone: 'info' });
  }
  const edited = (b: Block) => `edited → revision ${b.revision} · u = undo`;
  // e: the selected block in $EDITOR; a changed save becomes a new Revision. Checked first: a
  // block that cannot be edited is not opened.
  async function editBlock() {
    const block = selectedBlock();
    const error = block ? ops.editable(block) : null;
    if (!block || error) return error && setStatus({ text: error, tone: 'info' });
    try {
      const text = await deps.editor(block.content);
      operate(b => ops.edit(events(), b, text), b => edited(blockOf(b.id)));
      // A pending call edited is decided again by the rules.
      if (block.pending && blockOf(block.id).revision !== block.revision) loop.advance([edited(blockOf(block.id))]);
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)} – unchanged`, tone: 'error' });
    }
  }
  // On an unread @path reference, e opens the file itself.
  const edit = () => (selectedBlock()?.unread ? openReference(selectedBlock()!) : editBlock());
  // The file of an unread @path reference in $EDITOR; it is read on send.
  async function openReference(block: Block) {
    const { path } = parseReference(block.file!);
    try {
      await deps.project.open(path);
      k.reread();
      setStatus({ text: `${path} – read at send`, tone: 'info' });
    } catch (e) {
      setStatus({ text: `editor failed: ${errorText(e)}`, tone: 'error' });
    }
  }
  // Text selected with the mouse, copied on release.
  const copy = (text: string) => deps.clipboard(text).then(() => setStatus({ text: `copied ${text.length} chars`, tone: 'info' }));
  // A Tool Pair is marked as a whole: it is compacted only as a whole; a pending Tool Call not at all.
  // Like d, the selection then moves on to the next row.
  function toggleMark() {
    const block = selectedBlock();
    if (!block || ops.isFixed(block) || block.pending) return;
    const pair = pairOf(context().blocks, block.id);
    const on = !marked().has(block.id);
    setMarked(new Set([...marked()].filter(id => !pair.includes(id)).concat(on ? pair : [])));
    sel.selectAt(Math.max(...pair.map(id => shown().indexOf(id))) + 1);
  }

  return {
    api: {
      move, remove, undo, toggleMark,
      edit: () => void edit(),
      copy: (text: string) => void copy(text),
      // Any other key than the one asked for cancels the confirmation.
      cancelConfirm: () => {
        if (confirming()) setStatus(null);
        setConfirming(null);
      },
    },
  };
}
