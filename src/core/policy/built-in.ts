// The Context Policies shipped with resector, offered next to those in ~/.config/resector/policies (ADR 0001).
import type { Policy } from './policy';
import thinkingTrail from './thinking-trail';

export const BUILT_IN: Policy[] = [{ name: 'thinking-trail', run: thinkingTrail }];
