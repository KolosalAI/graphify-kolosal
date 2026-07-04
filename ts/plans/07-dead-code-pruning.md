# Plan 07 — Dead-Code Detection & Pruning (reachability over the call graph)

**Goal:** Use the resolved call graph ([Plan 04](04-call-graph.md) + [Plan 05](05-receiver-type-table.md))
to find **unreachable code** — definitions no execution path from an entry point can reach —
and produce a safe, reviewable prune plan (report first; deletion strictly opt-in). This is
the inverse of [Plan 06](06-god-node-ranking.md): god nodes are the most-reached; dead code
is the never-reached.

## Position in the pipeline

```
 … → [04] call graph → [05] type table → [06] god nodes
                       └──────────────→ [07] dead-code = graph reachability from roots
```

Consumes a finished `CallGraph`; emits a `DeadCodeReport` (+ optional edits to the Plan 02
extracted tree). Its accuracy is **bounded by resolution precision** — so pruning is
precision-first: when in doubt, keep.

## What "dead" means here

Not "in-degree 0" (that alone is wrong — an unused *entry point* has in-degree 0 but is
live). Dead = **not reachable from any root** through the call graph:

```
roots  ──calls/passes/constructs──▶  reachable set
everything else (callable defs)   =   dead candidates
```

## Roots (entry points) — what keeps code alive

A node is a root if it can be invoked from outside the graph's own call edges:

| Root kind | Detection |
|---|---|
| Module top-level code | calls whose `caller` is a `module` node (runs on import/exec) |
| `main` / `__main__` | `if __name__=="__main__"`, `func main()`, a `main`/CLI symbol (config) |
| Exported / public API | `export` (JS/TS), non-`_` top-level (python) — **library mode only** |
| Tests | file/func matches test patterns (`test_*`, `*.test.*`, `*_test.go`) |
| Framework hooks | decorated/annotated defs (`@app.route`, `@fixture`, DI) — config, best-effort |
| Referenced, not called | targets of **`passes`** edges (callbacks) and **`constructs`** (live classes) |

The `passes` edge from Plan 04 is essential: a function handed to `map`/an event bus is
live even with zero `calls` in-edges. Reachability must traverse `calls` **and** `passes`
(and `constructs` → class → its called methods).

## Algorithm — mark & sweep

1. **Collect roots** per the table + `opts.roots` overrides.
2. **Reachability BFS/DFS** from roots over `{calls, passes, constructs}` edges (follow
   `inherits` when a base method is reached so overrides in reachable subclasses stay live).
   Mark every visited callable node **live**.
3. **Sweep:** callable nodes (`function|method|lambda|class`) not marked live → dead
   candidates. (Single pass already captures transitive dead: if A is unreachable, so is
   everything only A reaches.)
4. **Classify confidence** (below) and emit the report.

No iteration needed for detection — one reachability pass yields the complete dead set.
(Iteration only matters if we *apply* deletions and want to re-confirm; the report is
already transitive.)

## Confidence — precision over recall

Imperfect resolution means some "dead" code may actually be reached via edges we failed to
resolve. Grade each dead candidate:

| Confidence | Condition |
|---|---|
| `high` (safe to prune) | unreachable **and** no unresolved/dynamic call site anywhere shares its name; not exported (in the active mode) |
| `medium` | unreachable but a same-named `unresolved`/`AMBIGUOUS` call exists → *might* be reached dynamically |
| `low` (flag only) | reachable only through `dynamic`/reflection sites, or name appears in a string/`passes` we couldn't resolve |

Only `high` is offered for automatic pruning; `medium`/`low` are reported for human review.
`opts.minConfidence` (default `high`) gates what `--apply` will touch.

## Modes

- **`application` / whole-program (default):** only real entry points are roots; unused
  `export`s **can** be dead. Best for apps, CLIs, services.
- **`library`:** every `export`/public symbol is a root — you can't see external callers, so
  public API is never dead. Best for packages.

`opts.mode` picks; misusing library code in application mode is the classic false-positive,
so default to the safer interpretation when unsure and surface the choice.

## The dynamic-reachability caveat (why we stay conservative)

Reflection, DI containers, string-dispatch (`getattr`, `eval`, `obj[name]()`), serialization
hooks, and framework magic invoke code with no static call edge. Plan 04 records these as
`unresolved`/`dynamic`. Rule: **any dead candidate whose name collides with an unresolved/
dynamic call site is downgraded to `medium`** — never auto-pruned. This is what stops us
deleting a route handler or a plugin that's wired up by name.

## Output & (opt-in) pruning

```ts
export interface DeadNode {
  id: string; label: string; kind: NodeKind; file: string;
  span: { startIndex: number; endIndex: number };
  reason: "unreachable" | "no-callers-non-root";
  confidence: "high" | "medium" | "low";
  dynamicRisk?: string; // the colliding unresolved/dynamic name, if any
}
export interface DeadCodeReport {
  mode: "application" | "library";
  roots: string[]; reachable: number; totalCallables: number;
  dead: DeadNode[];
  stats: { byConfidence: Record<string, number>; byKind: Record<string, number>; deadLoc: number };
}
export function findDeadCode(graph: CallGraph, opts?: DeadCodeOptions): DeadCodeReport;
```

- **Report-only by default** → `graphify-out/deadcode.json` + a printed summary (count,
  dead LOC, top files).
- **Prune plan:** group `high`-confidence dead spans by file → deletable ranges.
- **`--apply` (dry-run first):** operate on **copies** of the Plan 02 extracted tree
  (never the user's source directly), delete the spans, re-parse to confirm the file still
  parses (`hasError === false`), and write a diff. Refuse to apply if a deletion would
  break parsing (e.g. removing a decorator target) — precision guard.

## Config additions (per language)

Extend `CallGraphConfig`/a sibling with entry-point hooks:

```ts
mainMarkers?: Set<string>;      // "__main__" guard, main() name
exportMarkers?: Set<string>;    // export_statement / `export` modifier
testFilePatterns?: RegExp[];    // test_*.py, *.test.ts, *_test.go
testFuncPatterns?: RegExp[];    // ^test / _test$
entryDecorators?: string[];     // @app.route, @task, @fixture, @Component …
publicIsRoot?: boolean;         // python: non-underscore top-level treated public
```

## Verification (definition of done)

1. **Simple dead:** an unexported `helper()` no one calls (and not a root) → `high` dead;
   the entry `main()` (in-degree 0) is **not** dead.
2. **Callback keeps alive:** `foo` only ever `passes`ed into `register(foo)` is **live**.
3. **Transitive:** dead `A` that calls `B` (B otherwise unused) → both dead in one pass.
4. **Dynamic downgrade:** a dead-looking `handler` whose name matches an `unresolved`/
   `dynamic` call site → `medium`, not auto-pruned.
5. **Mode:** an unused `export function api()` is dead in `application` mode, **live** in
   `library` mode.
6. **Method reachability:** a method reached only via a resolved virtual call (Plan 05) is
   live; a private method no path reaches is dead.
7. **Apply safety:** `--apply` deletes only `high` spans on tree copies, re-parses each
   edited file, and aborts the file's edit if it no longer parses; dry-run shows the diff.

## Risks / open questions

- **Resolution-bound:** every `unresolved`/`dynamic`/`AMBIGUOUS` edge is a potential missed
  use → the confidence downgrade + `high`-only apply are the guardrails. Never claim
  certainty on `medium`/`low`.
- **Framework entry points** (routes, CLIs, serializers, DI) look dead without config;
  ship sensible `entryDecorators`/test patterns and let users extend — false deletions here
  are the worst outcome.
- **Exports in the wrong mode** = the top false-positive; default conservative, make mode
  explicit in the report.
- **Span deletion hazards:** decorators, overloads, docstrings, adjacent comments, and
  same-line siblings — the re-parse-after-delete gate catches breakage; still, keep
  `--apply` off by default and diff-first.
- **Not a linter for unused *locals*/imports** — this is graph-level unreachable *defs*;
  intra-function dead statements are out of scope.

## Phasing

1. `deadcode.ts` — root collection + reachability (`calls`+`passes`+`constructs`) +
   sweep + confidence grading; unit tests (cases 1–6 on hand-written/parsed graphs).
2. `config.ts` entry-point hooks (python/JS/TS: `__main__`, `export`, test patterns).
3. `findDeadCode` report + `main.js --deadcode` → `deadcode.json` + summary.
4. Prune plan (spans by file) + `--apply` (dry-run, tree-copy, re-parse-to-confirm, diff).
5. Extend framework/decorator roots; feed dead-LOC stats alongside god nodes for a
   "health" view.

---

## Execution status (implemented in `ts/src/graph/deadcode.ts` + `main.js`)

- **`findDeadCode(graph, opts)`** — reachability BFS from roots over `calls`+`passes`+
  `constructs`; sweep of unreachable callable defs; `high`/`medium` confidence grading.
- **Roots:** all `module` nodes (top-level exec), `mainMarkers` (Go `main`/`init`), test
  files/functions, framework `entryDecorators`, and — in `library` mode — `export`ed /
  public (`publicIsRoot`) defs. Config hooks added to `config.ts`; `exported`/`decorators`
  captured in Pass 1 (`extract.ts`) and carried onto nodes.
- **Confidence:** a dead candidate whose name matches an `unresolved` bare name **or**
  appears as a word inside a `dynamic` call expression (`getattr(x,'handler')`) is
  downgraded to `medium` (`dynamicRisk` recorded) — never treated as safe.
- **`main.js`** prints a summary and writes `graphify-out/deadcode.json`; `--library`
  selects library mode. **Report-only** — `--apply` (tree-copy + re-parse guard) is
  deferred to the next phase.
- **Verified — `npm run graph-smoke` → 35/35** (8 new): top-level-called code live;
  never-called `dead()` dead; **transitive** (`dead_chain` dead because its only caller is
  the dead `_helper`); callback kept alive via `passes(register(cb_fn))`; `public_api` dead
  in application mode but **live** in library mode; `getattr('handler')` downgrades
  `handler` to `medium`. `npm run typecheck` clean; `dist` rebuilt.
- **Demo** (`dead.zip`): `3 of 6 callables unreachable {high:3}` — `orphan` (uncalled),
  `helper` (only called by dead `orphan`), `never_used`; `run`/`greet`/`fmt` correctly live.

### Deviations / v1 scope
- **Report only** — no `--apply`/deletion yet (the risky part; phase 4).
- Export detection: JS/TS via `export_statement` parent; **`export const arrow`** (declarator
  under `lexical_declaration` under `export_statement`) not yet caught. Python/Go public via
  `publicIsRoot` name heuristic.
- `deadSpanChars` approximates dead volume (no per-line LOC — nodes carry char spans, not
  rows).
- Decorator entry roots captured for python; JS/TS decorator nodes not yet parsed.