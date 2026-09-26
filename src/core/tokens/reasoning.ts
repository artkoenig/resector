// Thinking blocks in the token split (FR-48): what their reasoning adds to the counted prefixes and to the
// request, measured by counting both again without it.
import type { Message, Request } from '../render/native';
import type { Reasoning } from './split';

// Counts of a backend: a prefix as counted for the split; the request, null when not sendable (it ends in
// an answer) – then the prefixes show what the next request renders.
export type Counter = { prefix: (request: Request) => Promise<number>; request: ((request: Request) => Promise<number>) | null };

// The request without the reasoning of message `at`.
function without(request: Request, at: number): Request {
  const messages = [...request.messages];
  const { reasoning_content: _, ...message } = messages[at] as Extract<Message, { role: 'assistant' }>;
  messages[at] = message;
  return { ...request, messages };
}

// Steps that add a message with reasoning: the Thinking blocks, and the index of their message.
const thinkingSteps = (requests: Request[]) =>
  requests.flatMap((r, step) => {
    const at = r.messages.length - 1;
    const last = r.messages[at];
    const added = at >= (requests[step - 1]?.messages.length ?? 0);
    return added && last?.role === 'assistant' && last.reasoning_content ? [{ step, at }] : [];
  });

// prefixes, total: the counts of `requests` (renderPrefixes) and of the whole request.
export async function reasoningOf(requests: Request[], prefixes: number[], total: number, count: Counter): Promise<Reasoning[]> {
  const whole = requests.at(-1)!;
  return Promise.all(
    thinkingSteps(requests).map(async ({ step, at }) => {
      const prefix = prefixes[step]! - (await count.prefix(without(requests[step]!, at)));
      const request = count.request ? total - (await count.request(without(whole, at))) : prefix;
      return { step, prefix, request, joined: requests[step + 1]?.messages.length === requests[step]!.messages.length };
    }),
  );
}
