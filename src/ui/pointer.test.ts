// Tests for the mouse pointer's OSC 22 sequences.
import { expect, test } from 'bun:test';
import { pointerSequence } from './pointer';

test('pointers are sent with their X11 names, none resets to the terminal default', () => {
  expect(pointerSequence('arrow')).toBe('\x1b]22;left_ptr\x1b\\');
  expect(pointerSequence('text')).toBe('\x1b]22;xterm\x1b\\');
  expect(pointerSequence('row-resize')).toBe('\x1b]22;sb_v_double_arrow\x1b\\');
  expect(pointerSequence()).toBe('\x1b]22;\x1b\\');
});
