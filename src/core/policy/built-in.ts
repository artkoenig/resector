// The Context Policies shipped with resector, offered next to those in ~/.config/resector/policies (ADR 0001).
import type { Policy } from './policy';
import summaryReset, { description } from './summary-reset';

export const BUILT_IN: Policy[] = [{ name: 'summary-reset', run: summaryReset, description }];
// On for new sessions unless the config's defaultPolicy says otherwise.
export const DEFAULT_POLICY = 'summary-reset';
