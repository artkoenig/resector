// The mouse pointer's shape, set with OSC 22 and the X11 cursor names.
import type { CliRenderer } from '@opentui/core';

export type Pointer = 'arrow' | 'text' | 'row-resize';

// X11 names, not CSS ones: xterm and iTerm2 know only these; kitty, Ghostty and foot take both.
const NAMES: Record<Pointer, string> = { arrow: 'left_ptr', text: 'xterm', 'row-resize': 'sb_v_double_arrow' };

// No pointer: back to the terminal's own.
export const pointerSequence = (pointer?: Pointer) => `\x1b]22;${pointer ? NAMES[pointer] : ''}\x1b\\`;

// OpenTUI's setMousePointer sends CSS names, which iTerm2 ignores; the native session's write is its (private) way
// to the terminal, ordered with the frames it writes.
type Output = { nativeSession: { write(bytes: Uint8Array): boolean } };
const encoder = new TextEncoder();

export function setPointer(renderer: CliRenderer, pointer?: Pointer) {
  (renderer as unknown as Output).nativeSession.write(encoder.encode(pointerSequence(pointer)));
}
