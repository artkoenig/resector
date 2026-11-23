# Parallel requests on local model servers

Research for issue #171 (map #170, Subagents). Question: what happens when two resector Sessions
send requests to the same local model server at once, what the user must configure, and what it costs.

Sources are the servers' own code and docs, read on 2026-11-23 at these commits:

- llama.cpp `212c547` — <https://github.com/ggml-org/llama.cpp/tree/212c547fe908b288f6659d48741e6ffac1ff409c>
- oMLX `dd14a81` — <https://github.com/jundot/omlx/tree/dd14a813b5eaa877889439600fea7d02260b1363>

Nothing here was run against a live server. Every claim is read from source or docs; see
[Unverified](#unverified) for what that leaves open.

## Short answer

- **Neither server fails** a second client. llama.cpp queues it without limit when no slot is free;
  oMLX batches up to 8 requests and queues the rest (503 + `Retry-After` when the queue is full, which
  resector already retries).
- **llama.cpp, default start (no `-np`)**: 4 slots over one shared KV pool. Two Sessions run in
  parallel, but each time one starts a request, every idle slot is copied to a RAM cache and cleared.
  A Session that pins its slot with `id_slot` (resector does) then appears to get nothing back and
  re-evaluates its whole prompt. The window resector shows is the whole pool, not a per-Session share.
- **llama.cpp, held up**: start with `-np N` and `-c N × window`. Each slot keeps its own KV in place
  and its own window (`-c / N`). Cost: N times the KV memory for the same window, or 1/N of the window
  for the same memory.
- **oMLX**: nothing to configure. The prefix cache is shared and keyed by content, so a second client
  does not evict the first one's blocks by taking a slot. The window is per request and not split.
  The limit is memory: under pressure new requests wait, and fail after 60 s without progress.
- **resector today**: pins `id_slot = hash(session) % total_slots`. Two Sessions collide on one slot
  with probability 1/N; then they run one after the other even when other slots are free, and swap
  the slot's state through the RAM cache on every turn.

## llama.cpp server

### Slots and their number

- A slot is one sequence in the shared `llama_context`; one request runs on one slot.
- `-np, --parallel N`: "number of server slots (default: -1, -1 = auto)"
  ([README](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/README.md)).
- Auto means 4 slots **and** a unified KV cache: "n_parallel is set to auto, using n_parallel = 4 and
  kv_unified = true"
  ([server.cpp L130-135](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server.cpp#L130-L135)).
- `-kvu, --kv-unified`: "use single unified KV buffer shared across all sequences (default: enabled if
  number of slots is auto)" (README). So an explicit `-np N` gives a split KV unless `-kvu` is added.

### How the context size is split

From [llama-context.cpp L411-425](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/src/llama-context.cpp#L411-L425):

- **Split KV** (`-np N`, no `-kvu`): `n_ctx_seq = n_ctx / n_seq_max`. Each slot gets `-c / N` tokens,
  fixed. `-c 32768 -np 4` is four windows of 8192.
- **Unified KV** (the default start): `n_ctx_seq = n_ctx`. Every slot may grow to the whole `-c`, but
  all slots draw from that one pool; the sum of all slots' tokens must fit in `-c`.
- `--kv-unified-per-slot N`: caps a slot at N tokens; without `-c` the pool is sized to
  `n_parallel × N` (README; [server.cpp L139-148](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server.cpp#L139-L148)).
- `/props` reports the per-slot size as `default_generation_settings.n_ctx` and the slot count as
  `total_slots` (README, `/props`). resector reads both.

When the unified pool runs full during a decode, the server first purges idle slots one at a time
("purging slot %d with %zu tokens", no save), then halves the batch size; at batch size 1 it sends
"Context size has been exceeded." to **every** processing slot and clears them all
([server-context.cpp L1844-1873, L4648-4695](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L1844-L1873)).
So with a unified pool one Session's growth can end the other Session's request.

A request larger than the slot fails on its own: "request (%d tokens) exceeds the available context
size (%d tokens), try increasing it"
([server-context.cpp L4041-4049](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L4041-L4049)).

### Which slot a request gets

`server_slot_sched::select` in
[server-slot-sched.cpp](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-slot-sched.cpp):

1. `id_slot` set (wraps around modulo the slot count): that slot. If it is busy, the task is deferred
   until it is free — other free slots are not used.
2. Otherwise the idle slot whose cached tokens share the longest common prefix with the new prompt,
   if that prefix is more than `--slot-prompt-similarity` (default 0.10) of the new prompt.
3. Otherwise an empty idle slot, else the least recently used idle slot.
4. No idle slot: the task is deferred.

README on the request field: "`id_slot`: Assign the completion task to an specific slot. If is -1 the
task will be assigned to a Idle slot. Default: `-1`".

### Queueing

- A deferred task goes to `queue_tasks_deferred` and is put back when a slot is released; tasks that
  asked for the released slot go first, else the oldest
  ([server-context.cpp L2983-2996](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L2983-L2996),
  [server-queue.cpp](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-queue.cpp), `defer` / `pop_deferred_task`).
- The code shows no cap on that queue and no 503 for a busy server; the HTTP request just stays open.
  The only timeout in the docs is `-to, --timeout N` "server read/write timeout in seconds (default:
  3600)" (README). 503 is documented for "Loading model" and for `/slots?fail_on_no_slot=1` only.

### Prompt cache: per slot, plus a RAM cache

- Per slot: `cache_prompt` (default `true`): "Re-use KV cache from a previous request if possible.
  This way the common prefix does not have to be re-processed" (README). The comparison is against
  the tokens the *slot* holds
  ([server-context.cpp L4064-4066](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L4064-L4066)).
- Server-wide RAM cache: `-cram, --cache-ram N` "maximum cache size in MiB (default: 8192 ...)"
  (README; [PR 16391](https://github.com/ggml-org/llama.cpp/pull/16391)). It holds serialized slot
  states, oldest dropped first when over the limit (`server_prompt_cache::alloc` / `update`).
- A slot's state is saved to the RAM cache, and the best matching cached state loaded into the slot,
  when the scheduler sets `update_cache`: the slot was picked by LRU, or the new prompt keeps less
  than half of what the slot holds (`f_keep < 0.5`). A cached state is only loaded if the new prompt
  keeps at least a quarter of it (`f_keep_cur < 0.25` is skipped).
- `--cache-idle-slots` (default on): "save idle slots to the prompt cache on new task, and clear them
  when using unified KV" (README). In code: after every task launch, each idle slot is saved; with a
  unified KV it is then cleared
  ([server-context.cpp L3025-3041](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L3025-L3041)).
  With a split KV the slot keeps its KV: "without a unified KV cache, clearing a slot frees no
  reusable room, so we only publish a RAM-cache copy of idle slots"
  ([server-context.cpp L1683-1695](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L1683-L1695)).

### What a second client does to the first one's cache

| Start | Second Session on another slot | Second Session on the same slot |
| --- | --- | --- |
| `-np N`, split KV | Nothing. Slot KV stays in place. | Slot state swapped through the RAM cache each turn (save + restore, bounded by `--cache-ram`); concurrent requests run one after the other. |
| default (auto, unified KV) | Each task launch saves and **clears** every idle slot. The idle Session gets its state back from the RAM cache only through the LRU path. | Same swap as above. |
| any, `--cache-ram 0` | Split KV: nothing. Unified KV: idle slots stay until the pool is full, then are purged without a copy. | The slot's previous state is lost; full re-evaluation. |

**Pinned slot plus unified KV (read from source, likely a full cache miss).** When the pinned slot was
cleared as idle, `select` returns it with `update_cache = false`: the similarity loop skips an empty
slot, and `f_keep = (f_sim_best * task.tokens.size()) / ret->prompt->tokens.size()` is `0 / 0`, so
`f_keep < 0.5f` is false and the LRU branch is not reached because a slot is already chosen. Without
`update_cache` the RAM cache is not consulted, and the slot starts empty. A Tool Loop is exactly this
pattern: Session A is idle while it runs a tool, Session B launches a request, A's slot is cleared,
A's next request names its slot and re-evaluates everything. Without `id_slot` the same request would
take the LRU path and restore from the RAM cache.

### Speed

- Slots are decoded together: one `llama_decode` call takes tokens from every processing slot, up to
  `n_batch` in total (`-cb, --cont-batching`, default on;
  [server-context.cpp L3938-3950](https://github.com/ggml-org/llama.cpp/blob/212c547fe908b288f6659d48741e6ffac1ff409c/tools/server/server-context.cpp#L3938-L3950)).
  Prompt evaluation of two slots therefore shares the batch; generation of two slots is one batch of
  two tokens.
- The docs give no numbers for the per-request slowdown. `/metrics` exposes
  `llamacpp:n_busy_slots_per_decode` and `llamacpp:requests_deferred` to observe it.

### What the user must configure

For N Sessions at once with a window of W tokens each:

```
llama-server -np N -c <N × W> --jinja ...
```

- Split KV, so every slot keeps its cache in place and `/props` reports W.
- Cost in memory: KV for N × W tokens instead of W. With fixed memory: the window shrinks to 1/N.
- Keep `--cache-ram` on (default 8192 MiB of host RAM) so a slot collision swaps state instead of
  losing it.
- The default start (no `-np`) works for one Session at a time; for two it runs but loses the cache as
  described above and overcommits the window.

## oMLX

### Concurrency and queueing

- "Handles concurrent requests through mlx-lm's BatchGenerator. Max concurrent requests is
  configurable via CLI or admin panel."
  ([README](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/README.md)).
  `--max-concurrent-requests` (default 8; `SchedulerSettings.max_concurrent_requests`,
  [settings.py L348](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/settings.py#L348)).
- Scheduler: "FCFS, configurable concurrency" (README, Architecture). Requests beyond the cap wait in
  `self.waiting`; the queue is capped at `max(max_num_seqs * 4, 32)` and a full queue raises
  `SchedulerQueueFullError`, mapped to "HTTP 503 + Retry-After"
  ([scheduler.py L11559-11582](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/scheduler.py#L11559-L11582),
  [server.py L1092-1114](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/server.py#L1092-L1114), `Retry-After: 1`).
- Some model types are forced to one request at a time: "serializing requests because its KV cache
  does not support multi-row batching yet"
  ([scheduler.py L2296-2303](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/scheduler.py#L2296-L2303));
  the cap also drops to 1 while a request recovers from memory pressure (`_effective_max_num_seqs`).
  Then the second Session queues behind the first.

### Cache

- No slots. The prefix cache is block based and shared: "Block-based KV cache management inspired by
  vLLM, with prefix sharing and Copy-on-Write" in two tiers, RAM (hot) and SSD (cold); blocks pushed
  out of RAM are "restored from disk instead of recomputed from scratch - even after a server restart"
  (README, Tiered KV Cache).
- Blocks are found by a chain hash of their tokens ("Chain hashing for prefix caching (hash depends on
  parent block)", reference counting, "LRU eviction"
  — [paged_cache.py header](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/cache/paged_cache.py)).
  Two Sessions with the same system prompt and tools share those blocks; a second client evicts the
  first one's blocks only through the size limits (`--hot-cache-max-size`, default off;
  `--paged-ssd-cache-max-size`, default `auto` = half of the free disk space), not by arriving.
- The window (`max_model_len`) is per request. Nothing is divided by the number of clients.

### Limits and cost

- Memory is the limit: each running request holds its own KV in RAM next to the weights. Under
  pressure the scheduler pauses admission ("New prefills wait; in-flight requests continue"), and a
  request that waits 60 s without progress ends with `finish_reason="error"`,
  `error_code="memory_admission_stalled"`
  ([scheduler.py L5069, L6084-6141, L13535-13540](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/scheduler.py#L6084-L6141)).
- Speed: by default a long prefill is not interleaved with decode steps (`chunked_prefill: False`,
  "Reduces TTFT for concurrent requests at the cost of per-step overhead"), and prefill shares the GPU
  with running decodes under `concurrent_priority: "balanced"`
  ([settings.py L344-362](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/omlx/settings.py#L344-L362)).
  The docs give no numbers.
- Splash models (oMLX's external engine): "Its context window is the whole KV pool, and concurrent
  requests that outgrow the pool wait for pages"
  ([docs/Splash.md](https://github.com/jundot/omlx/blob/dd14a813b5eaa877889439600fea7d02260b1363/docs/Splash.md), Memory).
  So with Splash two large Sessions share one window's worth of KV pages unless the memory limit is
  raised.

### What the user must configure

Nothing for two Sessions. Enough free memory for two KV states; with Splash a memory limit above one
window if both Sessions are large.

## How resector calls the servers today

`src/adapters/backend/` at `e40158e`:

- **Both**: chat over `POST /v1/chat/completions`, streamed (`openai.ts`, `streamChat`). A 503 is
  retried up to 10 times after `Retry-After` (`httpClient`), which fits oMLX's full queue. Nothing
  else about a busy server is handled; a queued llama.cpp request simply waits.
- **llama.cpp** (`llamacpp.ts`):
  - `/props` once per connection: `default_generation_settings.n_ctx` becomes the window (unless the
    Model Profile sets `window`), `total_slots` feeds the slot choice.
  - Counting through `/apply-template` and `/tokenize`; these take no slot.
  - Chat adds `id_slot: hash(session) % total_slots` and `n_cache_reuse: 0`. `cache_prompt` is not
    sent, so the server default `true` applies.
  - The cache prediction (`slotTokens`, `shownTokens`) is kept in the client and assumes nobody else
    touched the slot. The real hit comes back as `timings.cache_n`.
- **oMLX** (`omlx.ts`): `/v1/models` for `max_model_len`, `/v1/messages/count_tokens` for counts (at
  most 8 at a time), `/admin/api/cache/probe` for the cache prediction, no slot or session field in
  the chat request.

## What this implies for Subagents

1. **Slot pinning by hash is the weak point on llama.cpp.** Parent and Subagent land on the same slot
   with probability 1/`total_slots` (1/4 by default). Then the Subagent's request waits for the
   parent's even with idle slots, and each turn swaps the slot's state. A deterministic choice (the
   parent hands the Subagent another slot, or reads `/slots` for a free one) avoids it.
2. **With the default llama.cpp start, pinning looks worse than not pinning**: the cleared slot is
   not refilled from the RAM cache (see above). Either require `-np N` (split KV), or do not send
   `id_slot` when the server runs a unified KV. Without `id_slot` the server picks by common prefix;
   two Sessions share the system prompt and tools, so a new Subagent can match the parent's idle slot
   and push the parent's state to the RAM cache. That is an inference from `select`, not observed.
3. **The window resector shows is not a guarantee under a unified KV.** `/props` reports the whole
   pool per slot; two Sessions that both fill it end in "Context size has been exceeded." for both.
   With `-np N` the reported window is already the per-slot share.
4. **The Cached column can be wrong after another Session ran**, on llama.cpp only: the prediction is
   client-side. The answer's `cache_n` stays right.
5. **oMLX needs no change.** The 503 retry covers its queue; the cache probe asks the server and so
   stays right with several clients.
6. **"Another Model Profile whose endpoint already runs"** (settled on the map) sidesteps all of the
   above: a second server has its own slots, pool and cache. The cost is a second copy of the weights.

## Unverified

- Nothing was run. In particular the **pinned slot + unified KV full miss** is read from
  `server-slot-sched.cpp` only (the `0 / 0` in `f_keep`); it should be confirmed against a live
  `llama-server` (two clients, `id_slot` set, watch `timings.cache_n`) before a decision rests on it.
- **Speed cost** of two parallel requests: no first-party numbers for either server. Not measured.
- **No queue limit / no timeout** for deferred llama.cpp tasks: concluded from not finding one in
  `server-queue.cpp` and the README; the HTTP layer (`server-http.cpp`) was not read.
- **KV memory scales with `-c`** on llama.cpp: standard behaviour, not re-checked in this commit.
- oMLX: the cache code (`prefix_cache.py`, `paged_ssd_cache.py`) was read at header and settings level
  only; eviction order under a full hot cache or SSD limit was not traced. Whether
  `/v1/messages/count_tokens` and `/admin/api/cache/probe` bypass the scheduler queue was not checked.
- The exact per-request memory of a second oMLX request, and Splash's own request cap (resector's
  code comment says 32), were not checked.
- Open llama.cpp issues that touch this area were found by title only and not read:
  [#27148](https://github.com/ggml-org/llama.cpp/issues/27148) (RAM cache restores an unrelated
  conversation), [#30997](https://github.com/ggml-org/llama.cpp/issues/30997) (retry cached prompt
  restoration after clearing idle slots).
