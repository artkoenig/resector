// Colours shared by the screens: the Clean Dark theme (design system "Resector").
import type { Kind } from '../core/log/events';

// Grounds from back to front, then text from loud to quiet. Text holds 4.5:1 on every ground.
export const BG = '#0a0a0a';
export const PANEL_BG = '#141414';
export const SELECTED_BG = '#1e1e1e';
export const BORDER = '#2a2a2a';
export const TEXT = '#eeeeee';
export const MUTED = '#8a8a8a';
// Decoration only (template segment, cold cache), never text to read.
export const FAINT = '#5c5c5c';
// The one accent: app name, selection and prompt bar ┃, marks, cursor, User blocks.
export const ACCENT = '#fab283';

export const KIND_COLOR: Record<Kind, string> = {
  System: '#9d7cd8',
  Tools: '#5c9cf5',
  User: ACCENT,
  Thinking: '#a9a1e1',
  Assistant: '#56b6c2',
  'Tool Call': '#e5c07b',
  'Tool Result': '#b4b4b4',
  Note: '#e6a2c5',
};
export const TONE = { info: '#56b6c2', ok: '#7fd88f', warn: '#f5a742', error: '#e06c75' };
