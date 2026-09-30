// The Context Policies shipped with resector, offered next to those in ~/.config/resector/policies (ADR 0001).
import leanCompact, { description } from './lean-compact';
import type { Policy } from './policy';

export const BUILT_IN: Policy[] = [{ name: 'lean-compact', run: leanCompact, description }];
// On for new sessions unless the config's defaultPolicy says otherwise.
export const DEFAULT_POLICY = 'lean-compact';
