// Background Processes at the Gate: their exits logged, an exit Note for each before the next request, the user's kill.
import { onCleanup } from 'solid-js';
import { exitOf, owedExitNotes } from '../core/notes/background';
import type { Kernel } from './kernel';
import type { Background } from './ports';
import type { View } from './types';

export type BackgroundSlice = ReturnType<typeof createBackgroundSlice>;

export function createBackgroundSlice(k: Kernel, sel: View, background: Background | undefined) {
  if (background) {
    const off = background.onExit((pid, end) => {
      const exited = exitOf(k.events(), pid, end);
      if (exited) k.append(exited);
    });
    onCleanup(off);
  }

  // Before a request: a Note for every logged exit without one, also those logged before a switch, quit or crash.
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
