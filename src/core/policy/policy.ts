// Context Policies (ADR 0001): a stateless function over the Context whose operations the harness applies before
// every request, and after an answer ending the tool loop if it asks to send on (apply.ts), checked by the same rules as the user's (plan.ts), until it returns nothing. This file is
// the contract a policy module is written against.
import { z } from 'zod';
import type { Kind, Origin } from '../log/events';
import { pairOf, type Block, type Context } from '../log/fold';

// A Context Block as a policy sees it: tokens as rendered, the other block of its Tool Pair, whether it awaits approval.
export type PolicyBlock = { id: number; kind: Kind; origin: Origin; content: string; tokens: number; pair: number | null; pending: boolean };
// What the Gate knows when it calls the policy, passed on as is: the window.
export type Situation = { window: number };
// The Context the next request sends, the tokens it takes, and the Situation.
export type PolicyContext = Situation & { used: number; blocks: PolicyBlock[] };

export function viewOf(context: Context, counted: { blocks: number[]; total: number }, situation: Situation): PolicyContext {
  const blocks = context.blocks;
  const view = ({ id, kind, origin, content, pending }: Block, i: number): PolicyBlock => ({
    id, kind, origin, content, tokens: counted.blocks[i]!, pair: pairOf(blocks, id).find(other => other !== id) ?? null, pending: pending === true,
  });
  return { ...situation, used: counted.total, blocks: blocks.map(view) };
}

const id = z.number().int();
const OPERATION = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), id }),
  // inContext: the Compaction continues the Context as sent, the instruction appended (the server's prefix cache holds it).
  z.object({ op: z.literal('compact'), sources: z.array(id), instruction: z.string(), inContext: z.boolean().optional() }),
  z.object({ op: z.literal('edit'), id, content: z.string() }),
  z.object({ op: z.literal('move'), id, after: id }),
  z.object({ op: z.literal('note'), after: id, content: z.string() }),
  // Not a change: the Context is sent on, after an answer that ended the tool loop too (no user message needed).
  z.object({ op: z.literal('send') }),
  // Not a change: the next request goes with this thinking ('off', 'on' or an effort), not logged; later ones with the session's.
  z.object({ op: z.literal('thinking'), mode: z.string() }),
]);
export type PolicyOperation = z.infer<typeof OPERATION>;
// The operations that change the Context, checked by plan.ts.
export type ContextOperation = Exclude<PolicyOperation, { op: 'send' } | { op: 'thinking' }>;
// A policy module's default export; built-in policies are written the same way.
export type PolicyFunction = (context: PolicyContext) => PolicyOperation[] | Promise<PolicyOperation[]>;
// name: the module's file name; description: its `description` export, shown when choosing a policy.
export type Policy = { name: string; run: PolicyFunction; description?: string };

// A policy's module is not type-checked when loaded: what it returns is checked here.
export function parse(op: unknown): PolicyOperation | { error: string } {
  const parsed = OPERATION.safeParse(op);
  return parsed.success ? parsed.data : { error: `not an operation: ${JSON.stringify(op)}` };
}
