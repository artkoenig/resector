// Background Processes at the Gate: their exits logged, and an exit Note for each before the next request.
import { onCleanup } from 'solid-js';
import { exitOf, owedExitNotes } from '../core/notes/background';
import type { Kernel } from './kernel';
import type { Background } from './ports';

export type BackgroundSlice = ReturnType<typeof createBackgroundSlice>;

export function createBackgroundSlice(k: Kernel, background: Background | undefined) {
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

  // The log of a Tool Pair's Background Process (`id`: its call or result) as written so far: where it is, whether the
  // process still runs; null for a pair without one, or once the log is gone.
  function backgroundLog(id: number): { path: string; text: string; running: boolean } | null {
    const blocks = k.context().blocks;
    const call = blocks.find(b => b.id === (blocks.find(r => r.id === id)?.call ?? id));
    const text = call?.process && background?.log(call.process.log);
    return typeof text === 'string' ? { path: call!.process!.log, text, running: call!.process!.running } : null;
  }

  return { addExitNotes, api: { backgroundLog } };
}
