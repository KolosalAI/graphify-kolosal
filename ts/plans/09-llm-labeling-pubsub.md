# Plan 09 — Streaming LLM Labeling (pub-sub, per-feature events)

**Goal:** Turn Stage 5 LLM labeling ([Plan 08](08-logical-grouping.md), `llm.ts`) from a
batch *call-everything-then-return* into a **publish/subscribe stream**: iterate **one
feature at a time**, call the LLM, and **emit an event** carrying the feature's JSON + the
LLM result the moment that feature is labeled — continuing until every feature (then every
category) is done. Subscribers react incrementally.

## Why streaming instead of batch

The timing breakdown made it obvious: the whole static pipeline is ~20 ms, but **LLM
labeling dominates at ~7 s** and grows linearly with feature count. Batch labeling makes the
caller wait for *all* of it with zero feedback. A per-feature event stream unlocks:

- **Live progress / UI** — show each subsystem name as it lands, not a 30 s spinner.
- **Incremental persistence** — write each labeled feature to disk/DB as it completes, so a
  crash mid-run keeps partial results.
- **Decoupled consumers** — a websocket push, a queue, a log, a progress bar all subscribe
  to the same stream without the labeler knowing about them.
- **Backpressure** — a slow subscriber (persisting to a DB) can gate the next LLM call.

## Position

Refactor of `ts/src/group/llm.ts`. The deterministic grouping (Stages 1–4) is unchanged;
only *how labels are applied* changes: from `labelGrouping(g) → Promise<Grouping>` to an
event-emitting `Labeler` (with `labelGrouping` kept as a thin wrapper for callers that just
want the final result).

## The event model

```ts
export interface LabelEvent {
  level: "feature" | "category";
  index: number;          // 0-based within its level
  total: number;          // count at this level
  node: Feature | Category; // the JSON structure — already updated with the new label
  result: { label: string; description: string } | null; // raw LLM output (null → fallback)
  labeledBy: "llm" | "fallback";
  fromCache: boolean;
  ms: number;             // time spent on this item
}

export type LabelerEvents = {
  start: { featureTotal: number; categoryTotal: number };
  feature: LabelEvent;    // ← "labeling done for THIS feature" (the headline event)
  category: LabelEvent;
  progress: { level: "feature" | "category"; done: number; total: number };
  error: { level: "feature" | "category"; node: Feature | Category; error: string }; // then a *labeled* event still fires with fallback
  done: { grouping: Grouping; labeled: number; fallback: number };
};
```

Events, in order: `start` → (`feature` × N, interleaved `progress`) → (`category` × M,
`progress`) → `done`. An `error` for an item is **always followed by** that item's
`feature`/`category` event with `labeledBy:"fallback"` — the stream never stalls on a
failed call.

## API — subscribe, then run

```ts
export interface Labeler {
  on<E extends keyof LabelerEvents>(event: E, cb: (payload: LabelerEvents[E]) => void | Promise<void>): this;
  run(): Promise<Grouping>; // starts iteration; resolves at `done`
}
export interface LabelerOptions {
  concurrency?: number;     // default 3 — up to 3 LLM calls in flight; events emit on completion order
  awaitSubscribers?: boolean; // default true — await async handlers per emit (backpressure)
}
export function createLabeler(grouping: Grouping, opts?: LabelerOptions): Labeler;

// Backward-compatible convenience — subscribes internally, resolves with the final grouping.
export async function labelGrouping(grouping: Grouping): Promise<Grouping>;
```

A tiny typed emitter (a `Map<event, handlers[]>`) rather than Node's untyped
`EventEmitter`, so payloads are checked. `run()` is idempotent-guarded (one run per
labeler).

## Iteration model (per feature, not per whole model)

The core change: **no batch.** Each feature is its own LLM call + event; up to
`concurrency` (default **3**) are in flight, and each emits the instant it completes:

```ts
async run() {
  emit("start", { featureTotal: features.length, categoryTotal: categories.length });
  let done = 0;
  await pool(features, concurrency /* =3 */, async (f, index) => { // ≤3 in flight
    const t = now();
    const r = await labelOne(featureEvidence(f)); // LLM call + cache + fallback
    if (r) { f.label = r.label; f.description = r.description; f.labeledBy = "llm"; }
    const ev = { level:"feature", index, total: features.length, node: f,
                 result: r, labeledBy: f.labeledBy, fromCache: r?.cached ?? false, ms: now()-t };
    await emit("feature", ev);                     // ← subscribers react to THIS feature
    await emit("progress", { level:"feature", done: ++done, total: features.length });
  });
  // category pass — depends on the now-labeled feature names (also pooled at `concurrency`)
  … same shape, emit("category", …) …
  await emit("done", { grouping, labeled, fallback });
  return grouping;
}
```

- **Default `concurrency: 3`** — 3 features labeled in parallel; ~3× faster than serial while
  keeping per-feature events. Events fire in **completion order**, so payloads carry `index`
  (the stable position) — subscribers key off `index`, never arrival order.
- Set `concurrency: 1` for strictly-ordered per-feature streaming.
- Categories are always after all features (they consume feature labels), pooled the same way.
- With `awaitSubscribers`, `emit` awaiting handlers naturally caps effective parallelism to
  free pool slots — a slow subscriber throttles the LLM calls.

## Backpressure & async subscribers

`emit` **awaits** each handler when `awaitSubscribers` (default). So a subscriber that
persists to a DB or pushes over a socket can slow the loop deliberately — the next LLM call
won't fire until the handler resolves. Handlers that throw are caught and reported via an
`error` event (a bad subscriber never kills the run). Fire-and-forget subscribers just
return `void`.

## What carries over from Plan 08 (unchanged)

Per-feature LLM call, `response_format: json_object` + `/no_think`, robust JSON extraction,
30 s timeout + backoff retry, evidence-hash cache, env config (`QUICK_LLM_*`, key never
logged), injection-sandbox system prompt, and **fallback-safe** labeling. The pub-sub layer
wraps these — it does not weaken any of them. If there's no LLM config, `run()` still emits
`feature`/`category` events (all `labeledBy:"fallback"`) and `done` — the stream shape is
identical with or without the LLM.

## Integration — `main.js` is the subscriber, publishing JSON as it goes

`main.js` stops awaiting one batch call and instead **subscribes** to the stream, **printing
progress and re-publishing the JSON artifacts on every event** — so `grouping.json` and
`category-feature.json` are always current, updated the instant each feature/category is
labeled (not only at the end):

```js
const labeler = createLabeler(grouping, { concurrency: 3 });

// publish JSON incrementally — rewrite both artifacts as each item lands
const publish = () => {
  writeFileSync(join(outDir, "grouping.json"), JSON.stringify(grouping, null, 2));
  writeFileSync(join(outDir, "category-feature.json"), JSON.stringify(toCategoryFeatureSummary(grouping), null, 2));
};
labeler.on("start", (s) => console.log(`\nlabeling ${s.featureTotal} features via LLM (concurrency 3)…`));
labeler.on("feature",  (e) => { console.log(`  ✓ ${e.node.label}  (${e.labeledBy}, ${fmtMs(e.ms)}${e.fromCache ? ", cached" : ""})`); publish(); });
labeler.on("category", (e) => { console.log(`  ▸ ${e.node.label}`); publish(); });
labeler.on("error",    (e) => console.log(`  ! ${e.node.label}: ${e.error} → fallback`));
labeler.on("done",     (d) => { publish(); console.log(`labeled ${d.labeled}, fallback ${d.fallback}`); });

await labeler.run();
```

Effects:
- **Live output** — each subsystem name prints as it's labeled, with its per-item latency.
- **Progressive files** — a reader tailing `category-feature.json` sees it fill in; a crash
  mid-run leaves a valid, partially-labeled artifact (`meta.llm`/`complete` only set at
  `done`).
- **`--no-llm`** emits the identical event sequence instantly (all `fallback`), so `main`'s
  subscriber code is the same path with or without the LLM.
- Optional `--stream`: also append each `LabelEvent` as one NDJSON line to
  `graphify-out/labels.ndjson` for an external consumer.

## Verification (definition of done)

1. **Per-feature emission:** a 5-feature grouping fires exactly 5 `feature` events, each with
   `node` already carrying its new label and `result` the raw LLM JSON (or `null` on
   fallback). At default `concurrency:3` events arrive in completion order but every `index`
   0–4 appears exactly once; `concurrency:1` yields strict index order.
2. **Ordering:** `start` first, all `feature` before any `category`, `done` last; `progress`
   counts monotonically to total. **≤3 in flight:** never more than 3 concurrent LLM calls.
3. **Fallback stream parity:** with no key / `--no-llm`, the same event sequence fires, every
   `labeledBy:"fallback"`, and `done.fallback === featureCount+categoryCount`.
4. **Error resilience:** a forced LLM failure on one feature emits `error` **then** that
   feature's `feature` event with fallback; the run completes.
5. **Backpressure:** an async `feature` subscriber that sleeps delays the next item (measured
   ordering) when `awaitSubscribers`.
6. **Cache:** two features with identical evidence → second emits `fromCache:true`, no second
   HTTP call.
7. **Back-compat:** `labelGrouping(g)` still returns the fully-labeled grouping (implemented
   over the labeler).
8. **Incremental persistence:** subscribing a writer produces a `category-feature.json` that
   is valid after each event and final at `done`.

## Risks / open questions

- **Unbounded subscriber latency** stalls the run — document that `awaitSubscribers` handlers
  should be fast or opt out; consider a per-handler timeout.
- **Concurrency vs order:** the default `3` emits in completion (not input) order by design —
  `main`'s incremental `publish()` is order-independent (it re-serializes the whole tree), but
  any consumer keying on sequence must use `index`, not arrival. Drop to `1` for strict order.
- **Incremental publish cost:** re-serializing both JSON files on every event is O(tree) per
  item — fine for typical repos; for very large groupings, debounce the writes or publish only
  the changed subtree.
- **Partial-write consistency:** incremental `grouping.json` is valid JSON at each step but
  represents a *partial* labeling until `done` — mark `meta.llm`/a `complete` flag only at
  `done`.
- **Error semantics:** an `error` event is informational (fallback still applied); it must
  not be mistaken for a fatal — no `throw` escapes `run()` except programmer error.
- **Node EventEmitter temptation:** use the typed emitter; Node's emitter would lose payload
  types and swallow async-handler rejections.

## Phasing

1. Typed emitter + `createLabeler` skeleton emitting `start`/`feature`/`progress`/`done`
   over the existing per-feature call path (concurrency 1).
2. Category pass events; `error` + fallback-still-emits; `fromCache`/`ms` in payloads.
3. `awaitSubscribers` backpressure + `concurrency` option; reimplement `labelGrouping` as a
   wrapper.
4. `main.js` subscribers: progress line + incremental `category-feature.json` write.
5. Tests (verification cases) with a mock LLM (no network) + one live smoke.
6. (Optional) expose the stream outward — a `--stream` NDJSON mode writing one event per line
   for external consumers.

---

## Execution status — DONE (Stage 5 refactored to pub-sub)

Implemented in `ts/src/group/llm.ts` + `main.js`:

- **`createLabeler(grouping, { concurrency=3 })`** — a typed emitter (`.on(event, cb)` +
  `run()`) that iterates features then categories through a pool of 3, emitting
  `start`/`feature`/`category`/`progress`/`error`/`done`. Each `feature` event carries the
  updated `node` JSON, the raw `result` (or `null`), `labeledBy`, `fromCache`, and `ms`.
- **Backpressure** — `emit` awaits async subscribers (`awaitSubscribers`, default on);
  bad subscribers are caught, never killing the run.
- **Error-resilient** — a failed LLM call emits `error` **then** the item's event with a
  fallback label; the stream never stalls. (Seen live: a category call failed →
  `! Root: llm call failed → fallback`, run finished `labeled 7, fallback 1`.)
- **`main.js` is the subscriber** — logs each label as it lands (with per-item latency) and
  **`publish()`es `grouping.json` + `category-feature.json` on every event**, so both files
  stay current throughout the run.
- **Back-compat** — `labelGrouping(g)` retained, reimplemented over `createLabeler`.
- **Verified — `npm run group-smoke` → 19/19** (7 new, forced-fallback / no network): one
  event per feature, every `index` once, `start→features→categories→done` order, fallback
  parity (`result:null`, `labeledBy:"fallback"`), `done` tallies, back-compat return.
  `typecheck` clean; `dist` rebuilt. Live run against `qwen3.6-35b`: per-feature streaming at
  concurrency 3, incremental JSON publish, graceful error fallback.

### Notes / deferred
- **Concurrency 3 → completion-order events** (not index order); `main`'s `publish()` is
  order-independent. Use `index` for any sequence-sensitive consumer.
- **`--stream` NDJSON** (phase 6) not wired.
- LLM cache remains **per-labeler-run** (in-memory).