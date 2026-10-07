// The Context Policies shipped with resector, offered next to those in ~/.config/resector/policies (ADR 0001).
import guidedCompaction, { description as guided } from './guided-compaction';
import leanCompact, { description } from './lean-compact';
import type { Policy } from './policy';
import summaryReset, { description as reset } from './summary-reset';

export const BUILT_IN: Policy[] = [
  { name: 'lean-compact', run: leanCompact, description },
  { name: 'guided-compaction', run: guidedCompaction, description: guided },
  { name: 'summary-reset', run: summaryReset, description: reset },
];
// On for new sessions unless the config's defaultPolicy says otherwise.
export const DEFAULT_POLICY = 'summary-reset';
