// Background Processes at the Gate: their exits logged, an exit Note for each, which a Session at rest sends; the user's kill.
import { batch, createEffect, on, onCleanup } from 'solid-js';
import { endedBy, exitOf, owedExitNotes } from '../core/notes/background';
import type { Kernel } from './kernel';
import type { Background } from './ports';
import type { View } from './types';

export type BackgroundSlice = ReturnType<typeof createBackgroundSlice>;

// loopRests: nothing of the Tool Loop is left to decide or review; headless: a Headless Run drives the Gate, or did.
type Deps = { loopRests: () => boolean; headless: () => boolean; send: () => void };

export function createBackgroundSlice(k: Kernel, sel: View, background: Background | undefined, deps: Deps) {
  if (background) {
    const off = background.onExit((pid, end) => {
      const exited = exitOf(k.events(), pid, end);
      if (!exited) return;
      k.append(exited);
      // Ended by leaving the Session: told after its resume. A Headless Run is told with its next request.
      if (endedBy(end, 'session ended') || heldBack()) return;
      showExitNotes();
      // The user's own kill is no news to send.
      if (k.idle() && !endedBy(end, 'user') && deps.loopRests()) deps.send();
    });
    onCleanup(off);
    // Exits logged while no Gate was open; once every slice is there.
    queueMicrotask(() => heldBack() || showExitNotes());
    // Held back during the step: a microtask later, when the answer it ended with is in the Context.
    createEffect(on(heldBack, now => {
      if (!now) queueMicrotask(() => {
        if (!heldBack()) showExitNotes();
      });
    }, { defer: true }));
  }

  // While an answer, the active policy or the user's Compaction is under way, no Note comes in between: the Context
  // they work on stays, and the answer is not taken for one to the Note. A Headless Run adds it before its next request.
  function heldBack() {
    return deps.headless() || k.streaming() !== null || k.policing() !== null || k.compacting() !== null;
  }
  // The Note takes the id a running call's output is shown with: a selection there stays on the output.
  function showExitNotes() {
    const onOutput = k.running() !== null && sel.selected() === k.nextId();
    batch(() => {
      addExitNotes();
      if (onOutput) sel.setSelected(k.nextId());
    });
  }

  // A Note for every logged exit without one, also those logged before a switch, quit or crash.
  function addExitNotes() {
    for (const { exited, content } of owedExitNotes(k.events()))
      k.append({ type: 'BlockAdded', id: k.nextId(), kind: 'Note', origin: 'background', content, exited });
  }

  // The Background Process of a Tool Pair (`id`: its call or result), if it has one.
  function processOf(id: number | undefined) {
    const blocks = k.context().blocks;
    return blocks.find(b => b.id === (blocks.find(r => r.id === id)?.call ?? id))?.process;
  }

  // The log of a Tool Pair's Background Process as written so far: where it is, whether the process still runs; null
  // for a pair without one, or once the log is gone.
  function backgroundLog(id: number): { path: string; text: string; running: boolean } | null {
    const process = processOf(id);
    const text = process && background?.log(process.log);
    return typeof text === 'string' ? { path: process!.log, text, running: process!.running } : null;
  }

  // The selected Tool Pair's Background Process, while it runs.
  const selectedRunning = () => {
    const process = processOf(sel.selectedBlock()?.id);
    return process?.running ? process : undefined;
  };
  // The user ends it, also while streaming or running; its exit is logged when its process group is empty.
  function killBackground() {
    const process = selectedRunning();
    if (process) background?.stop(process.pid);
  }

  return { addExitNotes, api: { backgroundLog, killable: () => !!background && !!selectedRunning(), killBackground } };
}
