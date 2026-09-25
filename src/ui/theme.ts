// Colours shared by the screens.
import type { Kind } from '../core/log/events';

export const KIND_COLOR: Record<Kind, string> = {
  System: '#d787ff',
  Tools: '#5fafff',
  User: '#87d787',
  Assistant: '#5fd7d7',
  'Tool Call': '#ffd75f',
  'Tool Result': '#bcbcbc',
  Note: '#ff875f',
};
export const DIM = '#808080';
export const FREE_COLOR = '#444444';
export const SELECTED_BG = '#3a3a3a';
export const MARK_COLOR = '#ff875f';
export const TONE = { info: '#bcbcbc', ok: '#87d787', warn: '#ffd75f', error: '#ff5f5f' };
