// Context Policy (ADR 0001) at the Gate: the active policy edits the Context before a request; /policy switches it.
import * as compaction from '../core/compaction/compaction';
import { applyPolicy, type Ports, type Ran } from '../core/policy/apply';
import { summary } from '../core/policy/plan';
import type { Policy, Situation } from '../core/policy/policy';
import type { Thinking } from '../core/log/events';
import { inContextRequest } from '../core/render/compaction';
import { renderPrefixes, type Request } from '../core/render/native';
import { errorText, formatTokens, thinkingLabel } from './text';
import type { Kernel } from './kernel';
import type { Compactor, Policies, View } from './types';

export type PolicySlice = ReturnType<typeof createPolicy>;

export function createPolicy(k: Kernel, sel: View, policies: Policies, compactor: () => Promise<Compactor | null>) {
  const { backend, setStatus } = k;
  // What the policy did before the request being sent, for its status line; the thinking it asked for that request.
  let ran: string | null = null;
  let thinking: Thinking | undefined;

  const ports = (signal: AbortSignal, situation: Situation): Ports => ({
    events: k.events, append: k.append, situation, aborted: () => signal.aborted,
    count: context => backend().count(renderPrefixes(context)),
    compact: (context, sources, instruction, inContext) =>
      compact(inContext ? inContextRequest(context, instruction) : compaction.compactionRequest(context, sources, instruction), signal),
  });
  // A policy's Compaction runs like the user's, without review; its Note is the answer.
  async function compact(request: Request, signal: AbortSignal): Promise<string> {
    const own = await compactor();
    const on = own?.backend ?? backend();
    try {
      const { total } = await on.count([request]);
      if (total >= on.window) throw new Error(`request ${formatTokens(total)} ≥ window ${formatTokens(on.window)}`);
      const result = await on.chat(request, { signal, onDelta: () => {}, maxTokens: on.window - total });
      if (result.finish === 'aborted' || result.finish === 'length') throw new Error(result.finish === 'length' ? 'cut off at max_tokens' : 'aborted');
      return (request.answerStart ?? '') + result.content;
    } finally {
      // The session's server cache now holds the compaction request.
      if (!own) k.recount();
    }
  }

  // /policy <name> switches a policy on, /policy off off; alone it shows the active one and the names.
  function switchPolicy(name: string) {
    const values = ['off', ...policies.all.map(p => p.name)].join(' ');
    if (!name) return setStatus({ text: `policy ${policies.active()?.name ?? 'off'} · /policy ${values}`, tone: 'info' });
    const chosen = name === 'off' ? null : policies.all.find(p => p.name === name);
    if (chosen === undefined) return setStatus({ text: `unknown policy ${name}: ${values}`, tone: 'error' });
    policies.set(chosen);
    setStatus({ text: chosen ? `policy ${chosen.name} on – edits the Context before every request` : 'policy off', tone: 'info' });
  }

  // The policy edits the Context with what the Gate knows; Esc aborts it. A throw is its error.
  async function run(policy: Policy, situation: Situation, onlyToSend = false): Promise<Ran> {
    const abort = new AbortController();
    k.setPolicing({ name: policy.name, abort });
    try {
      return await applyPolicy(policy, ports(abort.signal, situation), { onlyToSend });
    } catch (e) {
      return { changes: [], error: errorText(e) };
    } finally {
      k.setPolicing(null);
      sel.keepSelection();
    }
  }
  const situation = (): Situation => ({ window: backend().window });
  // What the policy did goes into the status line of the request that follows; an error stops the Gate. A run before
  // the request keeps what the run after the answer did.
  function reported(result: Ran, policy: Policy): Ran {
    const shown = result.thinking === undefined ? result.changes : [...result.changes, { text: `thinking ${thinkingLabel(result.thinking)}` }];
    const did = shown.length ? summary(policy.name, shown) : null;
    if (result.error) setStatus({ text: [`policy ${policy.name}: ${result.error} – not sent`, did].filter(Boolean).join(' · '), tone: 'error' });
    else ran = did ?? ran;
    return result;
  }

  return {
    // What the view shows and does.
    api: {
      // The name of the policy editing the Context before a request.
      policing: () => k.policing()?.name ?? null,
      // The active Context Policy and the ones to switch on (ADR 0001).
      policy: () => policies.active()?.name ?? null,
      policyNames: () => policies.all.map(p => p.name),
      policyDescription: (name: string) => policies.all.find(p => p.name === name)?.description ?? null,
    },
    // The active policy edits the Context before a request; an error, its Compaction's too, stops the Gate: nothing is sent.
    async runPolicy(policy: Policy): Promise<boolean> {
      const result = reported(await run(policy, situation()), policy);
      thinking = result.error ? undefined : result.thinking;
      return !result.error;
    },
    // After an answer that ended the tool loop: whether the policy edited the Context and asks to send it on.
    async sendsOn(policy: Policy): Promise<boolean> {
      const { changes, error, send } = reported(await run(policy, situation(), true), policy);
      return !error && !!send && changes.length > 0;
    },
    switchPolicy,
    // What the policy did before this request, and the thinking it asked for it; read once.
    takeRan: () => {
      const taken = { did: ran, thinking };
      ran = null;
      thinking = undefined;
      return taken;
    },
    // A request not sent after the policy ran still says what the policy did.
    withDid: (did: string | null) => void (did && setStatus({ ...k.status()!, text: `${k.status()!.text} · ${did}` })),
  };
}
