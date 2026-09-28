# Context Policies edit the Context automatically

v1 left auto-compaction out of scope so that the user alone steers the Context. To try different ways of working without rebuilding the app, we now allow one **Context Policy** at a time to edit the Context automatically. A policy is a stateless function over the Context, applied before every request (including the automatic follow-up requests of the tool loop) and repeated until it returns nothing (at most 8 passes, then the Gate stops with an error). It may only use the ordinary Context operations (remove, compact, edit, move), checked by the same rules as the user's, plus adding a Note of its own (so it can tell the model what it does); its Compactions are accepted without review. Transparency replaces consent: every Context operation in the Session Log names who made it (`user` or the policy's name), the Gate shows what the policy did, and a failing policy or Compaction stops the Gate instead of sending.

## Consequences

- The policy always wins: an operation the user undoes is applied again before the next request while the policy is active. To keep a block, switch the policy off.
- The active policy belongs to the running app, not to the Session: off after every start, switched with `/policy <name>` / `/policy off`, never recorded in the Session Log. Replay never depends on the attribution label.
- Policies are TypeScript modules loaded at start only, from `~/.config/resector/policies/<name>.ts` (built-in ones are written the same way). No project-level policies: a cloned repository must not be able to run code. There is no hot reload; `/reload` is removed.
- Policies that rewrite early blocks invalidate the backend's KV cache from that point on; that cost is part of what an experiment measures.

## Considered Options

- Declarative rules in the config: safe and validatable, but every experiment would need new vocabulary.
- Policies that only propose operations for the user to confirm: keeps consent, but is not an automatic way of working.
- Event hooks (`onThinkingAdded` …) with policy state: more precise triggers, but state must survive resume; a stateless function over the Context expresses the same rules.
