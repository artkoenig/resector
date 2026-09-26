// Thinking blocks in the token split (FR-48): what each adds to its counted prefix and to the request,
// measured by counting both again without it.
import { withoutThinking, type AssistantMessage, type Request } from '../render/native';
import type { ThinkingShare } from './split';

// Counts of a backend: a prefix as counted for the split; the request, null when not sendable (it ends in
// an answer) – then the prefixes show what the next request renders.
export type Counter = { prefix: (request: Request) => Promise<number>; request: ((request: Request) => Promise<number>) | null };

// The request without the Thinking block of message `at`.
function without(request: Request, at: number): Request {
  const messages = [...request.messages];
  messages[at] = withoutThinking(messages[at] as AssistantMessage);
  return { ...request, messages };
}

// Steps that add a message with reasoning_content: the Thinking blocks, and the index of their message.
const thinkingSteps = (requests: Request[]) =>
  requests.flatMap((r, step) => {
    const added = r.messages.length > (requests[step - 1]?.messages.length ?? 0);
    const last = r.messages.at(-1) as Partial<AssistantMessage> | undefined;
    return added && last!.reasoning_content ? [{ step, at: r.messages.length - 1 }] : [];
  });

// prefixes, total: the counts of `requests` (renderPrefixes) and of the whole request.
export async function thinkingShares(requests: Request[], prefixes: number[], total: number, count: Counter): Promise<ThinkingShare[]> {
  const whole = requests.at(-1)!;
  return Promise.all(
    thinkingSteps(requests).map(async ({ step, at }) => {
      const prefix = prefixes[step]! - (await count.prefix(without(requests[step]!, at)));
      const request = count.request ? total - (await count.request(without(whole, at))) : prefix;
      return { step, prefix, request, joined: requests[step + 1]?.messages.length === requests[step]!.messages.length };
    }),
  );
}
