# Plan 06 — God Node Ranking (core abstractions of the call graph)

**Goal:** Rank the [Plan 04](04-call-graph.md) call graph to surface **god nodes** — the
most-connected *real* entities, the core abstractions the rest of the code orbits. This is
the TS port of graphify's `analyze.py::god_nodes`: **degree centrality + noise filters**,
computed on the assembled graph *after* resolution.

## Position in the pipeline

```
 … → [04] call graph → [05] type table (precision) → [06] god-node ranking → (summaries / "start here")
```

As established earlier: god nodes are computed **after** the graph is built and resolved —
degree only means something once cross-file edges exist. So Plan 06 consumes a finished
`CallGraph`; its quality is bounded by Plan 04/05 resolution precision, not the parser.

## The algorithm (port of `god_nodes`)

Port of [analyze.py:100](../../python/graphify/analyze.py#L100):

1. Compute **degree** for every node.
2. Sort descending by degree.
3. Walk from most- to least-connected, **skipping noise** (filters below).
4. Take the top **N** survivors → god nodes.

```ts
export interface GodNode {
  id: string;
  label: string;        // qualifiedName
  kind: NodeKind;
  file: string;
  degree: number;       // total (in+out) over ranked edge kinds
  inDegree: number;     // callers/importers/containers pointing at it
  outDegree: number;
  score: number;        // degree (or weighted; see options)
}
export function rankGodNodes(graph: CallGraph, opts?: GodNodeOptions): GodNode[];
```

## Which edges count (the key decision vs the Python port)

graphify runs on a single blended graph and uses raw total degree, then *filters out* file
hubs precisely because `contains`/`imports` accumulate mechanically. Our graph has typed
edge kinds, so we can be explicit instead of filtering after the fact:

| Edge kind | Counts toward degree? | Why |
|---|---|---|
| `calls` | **yes** (primary) | the real "everything reaches this" signal |
| `passes` | yes | higher-order usage is genuine coupling |
| `imports` | module-graph only | structural at function granularity |
| `contains` | **no** | mechanical (every def has one from its module/class) |
| `inherits`/`implements` | optional (small weight) | real OOP coupling, but structural |

Default **semantic degree = `calls` + `passes`** (+ `imports` when ranking the module
graph). Excluding `contains` is what stops modules/classes from mechanically dominating —
the same intent as graphify's `_is_file_node` filter, achieved by edge-kind selection.

Expose `opts.edgeKinds` and `opts.direction` (`"in" | "out" | "total"`, default `"total"`;
`"in"` surfaces *most depended-upon* — often the better "god" signal).

## Noise filters (port of graphify's exclusions)

Map graphify's filters onto our node model ([analyze.py:55](../../python/graphify/analyze.py#L55),
[:91](../../python/graphify/analyze.py#L91), [:156](../../python/graphify/analyze.py#L156),
[_BUILTIN_NOISE_LABELS :11](../../python/graphify/analyze.py#L11)):

| graphify filter | our equivalent |
|---|---|
| `_is_file_node` (file hubs, method stubs) | exclude `kind === "module"` (and don't count `contains`) |
| `_is_concept_node` (empty/synthetic source) | exclude `external === true` and any node with no real span |
| `_is_json_key_node` | n/a here (config/JSON handled at ingest); keep hook for later |
| `_BUILTIN_NOISE_LABELS` | already excluded in Plan 04 (builtins never become def nodes) |

So god candidates = `function | method | lambda | class` nodes with real spans. Modules and
externals are excluded by default (a `granularity:"module"` ranking flips this to rank
module nodes).

## Super-hub handling (port of the cluster exclusion intent)

graphify excludes top-percentile hubs before community detection so "staging/utility
super-hubs" don't inflate god-node rankings ([cluster.py:150](../../python/graphify/cluster.py#L150)).
Here the analogous concern is a utility called from everywhere (a logger, a `config`
accessor). Two options, both off by default:

- **Flag, don't drop:** mark a god node as `utilityHub: true` when its in-degree is a broad
  fan-in from many files/communities but it has low out-degree (leaf utility) — so callers
  can distinguish *architectural* hubs from *utility* hubs.
- **Percentile exclude:** `opts.excludeHubPercentile` drops nodes above a degree percentile
  from ranking (mirrors graphify) — use when utility hubs crowd out real abstractions.

Prefer flagging; keep the exclude as an escape hatch.

## Weighting

Edges carry `weight` (call-site count) from Plan 04. `opts.weighted` (default `true`) sums
weights instead of edge counts, so a function called 20 times outranks one called once.
`score = weighted degree`.

## Output & integration

`rankGodNodes(graph, { topN: 10 })` → ranked `GodNode[]`. Wire into `main.js`: after
`buildCallGraph`, print the top god nodes and write `godnodes.json` beside `callgraph.json`:

```
graphify-out/
  callgraph.json
  godnodes.json     # ranked [{ id, label, kind, degree, in, out, score, utilityHub? }]
```

Also expose `granularity:"module"` to rank the module projection (most-depended-upon
modules) — the coarse "which files are load-bearing" view.

## Proposed layout & API

```
ts/src/graph/
  rank.ts     # rankGodNodes(graph, opts) + degree/index helpers
  (index.ts)  # export rankGodNodes, GodNode, GodNodeOptions
```

```ts
export interface GodNodeOptions {
  topN?: number;                 // default 10
  edgeKinds?: EdgeKind[];        // default ["calls","passes"]
  direction?: "in" | "out" | "total"; // default "total"
  weighted?: boolean;            // default true
  granularity?: "function" | "module";
  excludeHubPercentile?: number; // optional super-hub drop
  flagUtilityHubs?: boolean;     // default true
}
```

Reuse the `CallGraph.index` (adjacency) from Plan 04 when present; otherwise build degree
from `edges` in one pass.

## Verification (definition of done)

1. **Hub ranks first:** a `util.fmt` called by many functions ranks above its callers;
   degree/in/out counts are correct over `calls`+`passes`.
2. **Modules & externals excluded** at function granularity; a `granularity:"module"` run
   ranks module nodes instead.
3. **`contains` doesn't inflate:** adding functions to a module doesn't raise the module's
   (excluded) rank, and a class isn't boosted purely by its method `contains` edges.
4. **Weighting:** a callee invoked N times outranks one invoked once (`weighted:true`).
5. **Direction:** `direction:"in"` surfaces most-depended-upon; `"out"` surfaces the
   biggest orchestrators.
6. **Utility-hub flag:** a broad-fan-in/low-fan-out leaf is flagged `utilityHub`, not
   silently dropped (unless `excludeHubPercentile` set).
7. **Determinism:** stable order for equal scores (tie-break by id) → snapshot-testable.

## Risks / open questions

- **Degree is a blunt instrument:** it favors breadth over structural importance.
  Betweenness/PageRank/eigenvector centrality catch different "gods" (bridges, transitive
  importance) — note as future `opts.metric`, but degree matches graphify and is cheap/O(E).
- **Resolution-bound quality:** `AMBIGUOUS`/unresolved edges distort degree. Consider
  `opts.minConfidence` to rank on `EXTRACTED`(+`INFERRED`) edges only, so guesses don't
  crown a false god.
- **Utility vs architectural hub** is heuristic; the flag may misfire — keep it advisory.
- **Small graphs** (single file) have trivial rankings; god nodes matter at corpus scale.

## Phasing

1. `rank.ts` — semantic-degree computation over selected edge kinds + `rankGodNodes` with
   filters; unit tests (hub-first, contains-excluded, weighting, direction).
2. Utility-hub flag + `excludeHubPercentile`; `granularity:"module"` ranking.
3. `main.js` integration → print top-N + write `godnodes.json`.
4. `opts.minConfidence` (rank on resolved edges) + tie-breaking/determinism.
5. (Future) pluggable `opts.metric` (betweenness/PageRank) for alternate "god" lenses.

---

## Execution status (implemented in `ts/src/graph/rank.ts` + `main.js`)

- **`rankGodNodes(graph, opts)`** — semantic degree over `calls`+`passes` (module ranking:
  `calls`+`imports`), `contains` deliberately excluded so modules/classes aren't inflated;
  filters exclude `module` + `external` nodes; `weighted` sums edge weights; `direction`
  (`in`/`out`/`total`); `excludeHubPercentile`; `flagUtilityHubs`; `minConfidence`.
  Deterministic (score desc, id tie-break).
- **`main.js`** prints the top-10 god nodes and writes `graphify-out/godnodes.json`.
- **Verified — `npm run graph-smoke` → 27/27** (7 new): the widely-called `lib.fmt` ranks
  #1 with `inDegree 3` and is flagged `utilityHub`; no module node ranked at function
  granularity; `direction:"out"` surfaces callers instead; `granularity:"module"` ranks
  module nodes by imports. `npm run typecheck` clean; `dist` rebuilt.
- **Demo output** (`main.js cg.zip`): ranks `svc.boot` (degree 4) first, then the call
  chain, with classes/methods included — a readable "start here" view.

### Bug fixed en route
- **`class` keyword collision:** TS/JS `classTypes` included bare `"class"`, which is the
  *keyword token* type in tree-sitter — it minted an anonymous class node per class. Removed
  `"class"` from `classTypes` (kept `class_declaration`/`abstract_class_declaration`).

### Deviations / v1 limits
- Metric is **degree only** (matches graphify, O(E)); betweenness/PageRank noted as future
  `opts.metric`.
- Utility-hub flag is heuristic (fan-in ≥ 3 files, out ≤ 1) — advisory, not dropped unless
  `excludeHubPercentile` is set.
- Ranking quality is bounded by Plan 04/05 resolution — `minConfidence` lets callers rank
  on `EXTRACTED`-only edges to avoid crowning a false god.
