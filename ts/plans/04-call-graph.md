# Plan 04 — Call Graph (paradigm-agnostic: "A calls B with args → return")

**Goal:** Turn the per-file ASTs from [Plan 03](03-parse-to-ast.md) into a **call graph**
whose central unit is a single, uniform idea:

> **A** (a caller) **invokes B** (a callee) **with arguments**, and the **return value**
> flows somewhere (bound to a name, returned, chained, awaited, or discarded).

Everything else — functions, methods, constructors, lambdas, operators, pipelines,
message sends — is a *shape* of that one relationship. The model is deliberately **not** a
1:1 port of graphify's `extract.py`; it is a more flexible, paradigm-neutral representation
optimized for *understanding how one unit of behavior reaches another*, across OOP,
functional, procedural, and other styles.

## Position in the pipeline

```
 .zip ─▶ [02] filter ─▶ [03] parse (AST) ─▶ [04] call graph ─▶ (graph assembly → rank/cluster)
                                    │
                          parseEach visitor: extract per-file IR here
```

## The hard constraint (from Plan 03)

`parseEach` **frees each tree right after the visitor.** Pass 1 runs *inside* the visitor
and copies everything into plain **IR** (types, names, ranges, arg text — never live
`Node`s). Pass 2 resolves across files from IR only. This is Plan 03's "copy out inside the
visitor" rule.

---

## The one central abstraction: a Call

A call graph edge is a projection of a richer **Call record**. Capturing args + return flow
(not just "A→B") is what makes the graph paradigm-agnostic and useful for reasoning.

```ts
export interface CallRecord {
  caller: string;              // enclosing callable id, or the module id for top-level calls
  callee: CalleeRef;           // resolved target(s) or an unresolved descriptor
  form: CallForm;              // how the call is written (below)
  args: Argument[];            // ordered; positional and/or named
  returns: ReturnBinding;      // what happens to the result
  site: { startIndex: number; endIndex: number };
  confidence: Confidence;      // EXTRACTED | INFERRED | AMBIGUOUS
}

export type CallForm =
  | "direct"        // f(x)                        procedural / functional
  | "method"        // obj.m(x)                    OOP instance dispatch
  | "static"        // Type.m(x) / Type::m(x)      OOP static/class method
  | "constructor"   // new Type(x) / Type(x)       OOP instantiation
  | "super"         // super()/super.m()           OOP up-call
  | "higher-order"  // map(f, xs) — a callable is an argument   functional
  | "pipeline"      // x |> f |> g, a.then(f).then(g)           functional
  | "operator"      // a + b resolving to an overload            OOP/other
  | "message"       // send(pid, msg), actor ! msg               concurrent/other
  | "dynamic";      // getattr/eval/reflection/method_missing    any

export interface Argument {
  position?: number;
  name?: string;                                   // for keyword/named args
  kind: "value" | "callable-ref" | "lambda" | "literal" | "spread" | "unknown";
  ref?: string;                                    // node id when kind is callable-ref/lambda
  text?: string;                                   // source slice (bounded)
}

export interface ReturnBinding {
  kind: "discarded" | "bound" | "returned" | "chained" | "awaited" | "yielded" | "spread";
  name?: string;                                   // bound variable, when kind==="bound"
  nextSite?: { startIndex: number; endIndex: number }; // the next stage, when chained
}
```

From each `CallRecord` we emit graph edges:

- **`calls`**: `caller → callee` (the invocation). Present for every form.
- **`passes`**: `caller → argCallable` when an argument is a `callable-ref`/`lambda`
  (higher-order wiring). *This is where we intentionally diverge from graphify*, which
  drops function-valued arguments as noise — here they are first-class functional signal.
- **`binds`**: `callee → boundName` (return flows into a variable/field) — optional, for
  data-flow-aware views.
- **`constructs` / `inherits` / `implements`**: OOP structural edges used to *resolve*
  dispatch (below), also emitted for the graph.

---

## Callable nodes (superset, not just named functions)

Anything invocable is a node, so functional and OOP constructs are represented uniformly.

```ts
export type NodeKind =
  | "module"
  | "function"     // named function / procedure
  | "method"       // function bound to a class/receiver
  | "constructor"
  | "lambda"       // anonymous function / closure / arrow — gets a synthetic id
  | "class"        // class / struct / record
  | "interface"    // interface / trait / protocol / typeclass
  | "callable-alias"; // const g = f  → g aliases the callable f
```

- **Lambdas/closures are nodes**, not skipped — a `map(xs, x => f(x))` yields a lambda node
  plus a `passes` edge, so functional flows are visible.
- **Aliases:** `const g = f` (or `g = f` where `f` is a callable) creates a
  `callable-alias` that resolves through to `f`, so `g()` edges to `f`. Handles first-class
  functions and re-exports.
- **Pattern-matched / multi-clause defs** (Haskell, Elixir, Erlang, Scala match): one
  logical callable node with multiple clause spans, not N separate nodes.

---

## Paradigm coverage (the point of this plan)

Each paradigm reduces to the same `CallRecord`; the config + resolver handle the shape.

### OOP
- **Nodes:** classes, interfaces/traits/protocols, methods (instance/static/abstract),
  constructors, destructors, mixins.
- **Dispatch resolution:** `recv.m()` resolves via the receiver's declared/inferred type to
  that type's method; **inheritance/override** is handled with `inherits`/`implements`
  edges — a virtual call resolves to the declared type's method and, when subtypes override
  it, is marked `AMBIGUOUS` across the override set (or narrowed by known receiver type).
- **Forms:** `method`, `static`, `constructor`, `super`, and **operator overloading** →
  `operator` form resolving to the operator method.

### Functional
- **First-class functions:** aliases, functions passed as args (`passes` edges), returned
  from functions (`returns` a `callable-ref`).
- **Higher-order:** `map`/`filter`/`reduce`-style — the HOF gets a `calls` edge; each
  function argument gets a `passes` edge. So `map(f, xs)` shows both "caller → map" and
  "caller → f".
- **Currying / partial application:** `add(1)(2)` → chained calls (`returns.kind:"chained"`
  with `nextSite`).
- **Composition / pipelines:** `x |> f |> g`, `compose(f,g)`, `promise.then(f).then(g)` →
  `pipeline` form; each stage is a call whose return chains to the next.
- **Pattern-match dispatch & guards:** multiple clauses collapse to one callable node.

### Procedural / imperative
- Plain `direct` calls; module-level calls attributed to the module node; macro/`#define`
  expansions where the grammar exposes them.

### Concurrent / message-passing & dynamic
- **Message passing / actors:** `send(pid,msg)`, `pid ! msg`, channel ops, `go f()` →
  `message` (or `direct` for goroutines) form; the payload is an `Argument`.
- **Async:** `await f()` sets `returns.kind:"awaited"`; generators use `"yielded"`.
- **Dynamic/reflection:** `getattr`, `eval`, `method_missing`, `apply/call` → `dynamic`
  form, callee left unresolved (recorded, low/without confidence) rather than guessed.

---

## Per-language config (extensible, paradigm-aware)

Generalizes graphify's `LanguageConfig` with paradigm hooks. A language only fills what it
has; absent capabilities degrade gracefully (still get module/import nodes).

```ts
export interface CallGraphConfig {
  // definitions
  functionTypes: Set<string>;
  methodTypes: Set<string>;
  lambdaTypes: Set<string>;            // arrow_function, lambda, closure_expression, block
  classTypes: Set<string>;
  interfaceTypes: Set<string>;         // interface / trait / protocol / typeclass
  nameField: string;
  // calls
  callTypes: Set<string>;              // call, call_expression, new_expression, …
  constructorCallTypes: Set<string>;   // new_expression, struct literal, …
  callCalleeField: string;
  argsField: string;                   // argument list node → Argument[]
  accessorTypes: Set<string>;          // member/attribute access
  accessorNameField: string;
  accessorObjectField: string;
  // paradigm hooks (optional)
  inheritanceFields?: string[];        // extends/implements/with fields on a class node
  pipelineOperators?: string[];        // "|>", "|>", ">>", "."(then-chains handled structurally)
  aliasAssignmentTypes?: Set<string>;  // assignments that can bind a callable to a name
  asyncMarkers?: Set<string>;          // await/async node types
  messageSendTypes?: Set<string>;      // send/! /channel-op node types
  boundaryTypes: Set<string>;          // opens a new caller scope (functions, lambdas, methods)
}
```

Seed configs from the Python/JS/TS defaults in `extract.py`, then extend with lambda/
alias/pipeline hooks per language. Missing config → module + import nodes only.

---

## Main entry point: `generateCallGraph`

The core of this plan is one pure function that **takes ASTs and returns the call graph
structure** — no IO, no wasm, no live trees. It consumes Plan 03's *serialized* ASTs
(`AstNode` from `serializeAst`), which survive tree deletion, so it is decoupled from
web-tree-sitter and trivially unit-testable with hand-written `AstNode`s.

```ts
export interface FileAst {
  relPath: string;      // module identity
  key: string;          // grammar key → selects the CallGraphConfig
  root: AstNode;        // serialized AST from Plan 03 (serializeAst)
  source?: string;      // optional; enables precise arg/return text slicing
}

export interface CallGraphOptions {
  granularity?: "function" | "module" | "both";  // default "function"
  keepCallRecords?: boolean;                      // retain rich CallRecord[] (args + return)
  externalNodes?: boolean;                        // emit an `external` node for builtins/unresolved
}

/** THE main function: ASTs in → call graph out. Runs Pass 1 + Pass 2 internally. */
export function generateCallGraph(asts: FileAst[], opts?: CallGraphOptions): CallGraph;
```

- **Corpus in, graph out.** Cross-file resolution needs the whole set, so it takes an
  **array** of `FileAst`. A single-file call graph is just `generateCallGraph([oneFile])`
  — only intra-file edges resolve; unresolved externals are recorded, not invented.
- **Deterministic & synchronous** — same ASTs → same graph (stable ids), safe to snapshot.
- Internally: `Pass 1` (per `root` → `FileIR`) then `Pass 2` (resolve `FileIR[]` → graph).

Everything else is plumbing around this function. `buildCallGraph` (below) is the async
pipeline wrapper that feeds it from a zip.

## Two-pass algorithm (internals of `generateCallGraph`)

### Pass 1 — per file: `FileAst.root` → `FileIR`
Single recursive walk over the serialized `AstNode` tree, maintaining a **scope stack**
(via `boundaryTypes`), emitting: `defs` (all callable nodes incl. lambdas, with scope),
`calls` (full `CallRecord`s incl. parsed `args` and `returns` read from the surrounding
assignment/expression), `imports`, `aliases` (`name → callable`), and `inherits`/
`implements` relations. Names come from child nodes' `field`/`text`; arg/return text from
the node spans (or `source` slice when provided). Because the input is already serialized,
there is no live tree to manage here.

### Pass 2 — corpus-wide resolution → `CallGraph`
1. Materialize nodes + `contains`/`inherits`/`implements` edges; assign stable ids.
2. Build symbol tables: per-module (`name→def`), global (`name→def[]`), import map, and an
   **alias map** (`g→f`) resolved transitively.
3. Resolve each `CallRecord.callee` in priority order:

   | Tier | Match | Confidence |
   |---|---|---|
   | 1 | same-scope / same-file def (or resolved alias) | `EXTRACTED` |
   | 2 | imported name → its module's def | `EXTRACTED` |
   | 3 | method on a known receiver type (`d=Dog(); d.m()`), incl. inherited method | `EXTRACTED` |
   | 4 | virtual method with overrides in subtypes | `AMBIGUOUS` (edge per override) |
   | 5 | globally-unique def by name | `INFERRED` |
   | 6 | multiple defs by name | `AMBIGUOUS` |
   | – | dynamic / builtin / no match | record unresolved (no invented edge) |

4. Emit `calls` for the invocation, `passes` for each callable argument, and (optional)
   `binds` for the return. Aggregate for the module projection.

### Guards — capture, don't over-drop
Graphify is precision-first and discards function-valued call arguments. Here the aim is
*understanding flow*, so:
- A bare function name **as an argument** → **`passes` edge**, not a `calls` edge (we don't
  claim A calls it, but we record A hands it to B).
- Local/param **shadowing** still suppresses a false `calls` edge to a same-named def, but
  the shadowed callable, if itself invoked, is tracked via the alias map.
- **Builtins** get a `calls` edge to a shared `external` node (or are dropped) — configurable;
  they're kept out of the *definition* node set either way.
- **Dynamic** calls are recorded with `form:"dynamic"` and left unresolved rather than
  guessed — visible as a gap, not a wrong edge.

---

## Two granularities

Build the **function/callable-level** graph first, then derive the **module-level** call
graph by projection (collapse each node to its file, aggregate `calls`, dedup, sum weights).
Expose `granularity: "function" | "module" | "both"`. A module→module `calls` edge with no
matching `imports` edge is a *surprising* connection worth surfacing downstream.

---

## Proposed layout & API

```
ts/src/graph/
  config.ts      # CallGraphConfig per grammar key (paradigm-aware)
  model.ts       # NodeKind, CallRecord, CallForm, Argument, ReturnBinding, edges, CallGraph, FileAst
  extract.ts     # Pass 1: FileAst.root (AstNode) -> FileIR
  resolve.ts     # Pass 2: FileIR[] -> CallGraph (symbol/alias tables, tiers, guards)
  project.ts     # callable-graph -> module-graph projection
  callgraph.ts   # generateCallGraph(asts) [MAIN] + buildCallGraph(prepared) pipeline wrapper
  index.ts
```

```ts
export interface CallGraph { nodes: GraphNode[]; edges: GraphEdge[]; calls?: CallRecord[]; }

// ── MAIN FUNCTION ────────────────────────────────────────────────────────────
// ASTs in → call graph out. Pure, synchronous, deterministic. (Signature above.)
export function generateCallGraph(asts: FileAst[], opts?: CallGraphOptions): CallGraph;

// ── Pipeline wrapper ─────────────────────────────────────────────────────────
// Feeds generateCallGraph from a zip: extract/filter (02) → parse+serialize (03) →
// generateCallGraph → optional emit. Thin; all graph logic lives in generateCallGraph.
export async function buildCallGraph(
  prepared: PreparedTree,
  opts?: CallGraphOptions & { emitDir?: string },
): Promise<CallGraph>;
```

`buildCallGraph` runs `parseEach(prepared, pf => asts.push({ relPath: pf.relPath, key: pf.key,
root: serializeAst(pf.tree.rootNode), source: pf.source }))`, then returns
`generateCallGraph(asts, opts)`. `keepCallRecords` retains the rich `CallRecord[]` (args +
return) for flow-aware analysis; `emitDir` writes `callgraph.json` beside the AST dump.

### IDs
Deterministic/stable: `module:<relPath>`, `func:<relPath>#<qualifiedName>@<startIndex>`,
`lambda:<relPath>@<startIndex>`; methods qualified by class (`Dog.bark`). Spans keep
overloads/locals distinct.

---

## Output structure — the processed call graph

This is the exact shape `generateCallGraph` returns (and what `emitDir` writes to
`callgraph.json`) **after** Pass 2 resolution. It is self-describing: every node has a
stable id, every edge references resolved node ids, and everything that could **not** be
resolved is preserved in `unresolved` rather than silently dropped.

```ts
export interface CallGraph {
  meta: CallGraphMeta;
  nodes: GraphNode[];            // resolved, deduped, stable-id'd
  edges: GraphEdge[];            // from/to reference node ids
  unresolved: UnresolvedCall[];  // dynamic/builtin/no-match/ambiguous-dropped — kept as gaps
  calls?: CallRecord[];          // rich records (args + return) — only when keepCallRecords
  index?: GraphIndex;            // optional adjacency for O(1) traversal/queries
}

export interface CallGraphMeta {
  granularity: "function" | "module" | "both";
  fileCount: number;             // FileAst inputs processed
  languages: string[];           // grammar keys present
  counts: {
    nodes: number;
    edges: number;
    byNodeKind: Partial<Record<NodeKind, number>>;
    byEdgeKind: Partial<Record<EdgeKind, number>>;
    byConfidence: Partial<Record<Confidence, number>>;
    unresolved: number;
  };
}

export interface GraphNode {
  id: string;                    // e.g. "func:util.py#greet@14"
  kind: NodeKind;                // module | function | method | constructor | lambda | class | interface | callable-alias
  name: string;                  // "greet"
  qualifiedName: string;         // "util.greet" / "Dog.bark" — disambiguated
  file: string;                  // relPath (== name for module nodes)
  key: string;                   // grammar key
  startIndex: number;            // span in source (UTF-16); 0/0 for synthetic/external
  endIndex: number;
  scope?: string;                // enclosing node id (nested fns/methods)
  external?: true;               // builtin / out-of-corpus target
}

export interface GraphEdge {
  from: string;                  // node id (caller / owner)
  to: string;                    // node id (callee / member / import target)
  kind: EdgeKind;                // calls | passes | binds | constructs | contains | imports | inherits | implements
  confidence: Confidence;        // EXTRACTED | INFERRED | AMBIGUOUS
  form?: CallForm;               // for `calls`: direct | method | static | constructor | super | higher-order | pipeline | operator | message | dynamic
  site?: { startIndex: number; endIndex: number }; // call/reference site
  weight?: number;               // occurrence count (esp. after module projection)
}

export interface UnresolvedCall {
  caller: string;                // node id of the enclosing caller (or module)
  callee: string;                // the name/expression we couldn't resolve
  form: CallForm;
  reason: "dynamic" | "builtin" | "no-match" | "ambiguous-dropped";
  site: { startIndex: number; endIndex: number };
}

export interface GraphIndex {
  byId: Record<string, GraphNode>;
  out: Record<string, string[]>; // node id → outgoing edge indices (into edges[])
  in: Record<string, string[]>;  // node id → incoming edge indices
}
```

### Worked example

For `util.py`:
```python
def format(x): ...
def greet(name):
    return format(name)     # greet → format
run(greet)                  # top-level: module calls run (external), passes greet
```

`generateCallGraph` returns (default options — no external nodes):
```jsonc
{
  "meta": {
    "granularity": "function",
    "fileCount": 1,
    "languages": ["python"],
    "counts": {
      "nodes": 3, "edges": 4,
      "byNodeKind": { "module": 1, "function": 2 },
      "byEdgeKind": { "contains": 2, "calls": 1, "passes": 1 },
      "byConfidence": { "EXTRACTED": 4 },
      "unresolved": 1
    }
  },
  "nodes": [
    { "id": "module:util.py", "kind": "module", "name": "util.py", "qualifiedName": "util", "file": "util.py", "key": "python", "startIndex": 0, "endIndex": 78 },
    { "id": "func:util.py#format@0", "kind": "function", "name": "format", "qualifiedName": "util.format", "file": "util.py", "key": "python", "startIndex": 0, "endIndex": 18, "scope": "module:util.py" },
    { "id": "func:util.py#greet@19", "kind": "function", "name": "greet", "qualifiedName": "util.greet", "file": "util.py", "key": "python", "startIndex": 19, "endIndex": 63, "scope": "module:util.py" }
  ],
  "edges": [
    { "from": "module:util.py", "to": "func:util.py#format@0", "kind": "contains", "confidence": "EXTRACTED" },
    { "from": "module:util.py", "to": "func:util.py#greet@19", "kind": "contains", "confidence": "EXTRACTED" },
    { "from": "func:util.py#greet@19", "to": "func:util.py#format@0", "kind": "calls", "confidence": "EXTRACTED", "form": "direct", "site": { "startIndex": 47, "endIndex": 58 } },
    { "from": "module:util.py", "to": "func:util.py#greet@19", "kind": "passes", "confidence": "EXTRACTED", "site": { "startIndex": 64, "endIndex": 73 } }
  ],
  "unresolved": [
    { "caller": "module:util.py", "callee": "run", "form": "direct", "reason": "no-match", "site": { "startIndex": 60, "endIndex": 73 } }
  ]
}
```

Note how the single line `run(greet)` yields **two** graph signals plus a gap: a `passes`
of `greet` (a real, resolved callable) into the call, and an `unresolved` entry for `run`
(no def in this corpus) — exactly the flexible "A calls B with these arguments"
understanding this plan targets, with nothing silently lost.

> **Invariant:** every `edge.from`/`edge.to` references an id present in `nodes` — edges
> never dangle. With `externalNodes: true`, unresolved targets are instead materialized as
> `{ external: true }` nodes (e.g. `external:run`) and get a real `calls` edge, trading a
> larger node set for edge-complete traversal; the default keeps them in `unresolved`.

---

## Verification (definition of done)

1. **Procedural:** `a()` calls `b()` → `a →calls b`; top-level `b()` → `module →calls b`.
2. **Functional HOF:** `map(f, xs)` → `caller →calls map` **and** `caller →passes f`;
   `const g = f; g()` → `caller →calls f` via the alias.
3. **Pipeline/curry:** `x |> f |> g` and `add(1)(2)` produce chained `CallRecord`s with the
   right `returns.kind` and stage order.
4. **OOP dispatch:** `d = Dog(); d.bark()` → `Dog.bark` (`EXTRACTED`); overridden virtual
   method → `AMBIGUOUS` across overrides; `super.m()` → `super` form to the base method;
   `new Dog()` → `constructs`.
5. **Message/async/dynamic:** `send(pid,msg)` → `message` form; `await f()` →
   `returns:"awaited"`; `getattr(o,"m")()` → `dynamic`, unresolved (no invented edge).
6. **Guards:** a callable passed as an arg yields `passes` not `calls`; a shadowing local
   suppresses the false `calls`; builtins create no def node.
7. **Module projection** aggregates correctly; **no live Node/Tree retained** past the
   visitor; end-to-end `buildCallGraph` on the Plan 03 demo zip matches a golden fixture.
8. **`generateCallGraph` is unit-testable in isolation:** hand-written `FileAst[]` (no zip,
   no parser) produces the expected `CallGraph`; same input → identical output (stable ids).

## Risks / open questions

- **Static limits:** dynamic dispatch, reflection, and runtime-built dispatch tables can't
  be fully resolved — record as `dynamic`/`AMBIGUOUS`; prefer precision on `calls`, breadth
  on `passes`.
- **Type inference depth:** method dispatch (tier 3/4) needs receiver types; start with
  same-scope instantiation + declared types, defer full inference.
- **Arg/return extraction cost:** parsing every argument list adds work; gate deep arg
  capture behind `keepCallRecords` so the plain edge build stays cheap.
- **Config breadth:** each paradigm hook is per-language; ship Python/JS/TS first, expand.
- **Divergence from graphify is intentional:** `passes`/lambda nodes/alias resolution are
  new surface graphify doesn't emit — validate they don't drown the `calls` signal
  (separate edge kinds keep them filterable).

## Phasing

1. `model.ts` (CallRecord + edges + `FileAst`) + `config.ts` (Python/JS/TS, incl. lambda/
   alias hooks).
2. `extract.ts` — Pass 1: `AstNode` → `FileIR` (args, returns, lambdas, aliases, inheritance).
3. `resolve.ts` — Pass 2 tiers + alias/type resolution + capture-not-drop guards.
4. `callgraph.ts` — wire **`generateCallGraph(asts)`** (the main function) = Pass 1 + Pass 2;
   unit-test it with hand-written `FileAst[]`. Then `project.ts` + `buildCallGraph` wrapper
   + `emitDir`; `keepCallRecords` flow view.
5. `--callgraph` mode in `main.js` (zip → `generateCallGraph` → `callgraph.json`).
6. Extend configs to OOP-heavy (Java/C#/Kotlin/Swift) and functional (OCaml/Elixir/Scala)
   languages; hand nodes/edges to assembly → ranking/clustering.

---

## Execution status (implemented in `ts/src/graph/` + `ts/main.js`)

| File | Role |
|---|---|
| `src/graph/model.ts` | `CallGraph`/`GraphNode`/`GraphEdge`/`CallRecord`/`FileAst` + IR types |
| `src/graph/config.ts` | `CallGraphConfig` for python, javascript, typescript, tsx, go |
| `src/graph/extract.ts` | Pass 1: serialized `AstNode` → `FileIR` (defs, calls, args, imports, aliases, inherits) |
| `src/graph/resolve.ts` | Pass 2: symbol/alias/import tables, resolution tiers, guards → `CallGraph` |
| `src/graph/project.ts` | `projectToModules` (function graph → module graph) |
| `src/graph/callgraph.ts` | **`generateCallGraph(asts)`** [main] + `buildCallGraph(prepared)` wrapper |
| `src/graph/smoke.ts` | `npm run graph-smoke` |

- **`generateCallGraph` is the main function**, pure & synchronous, takes `FileAst[]`
  (serialized ASTs) → `CallGraph`. `buildCallGraph` feeds it from a zip and writes
  `callgraph.json`.
- **Verified — `npm run graph-smoke` → 15/15:** intra-file calls, cross-file via import
  (`EXTRACTED`), top-level→module attribution, `passes` for higher-order args, OOP class/
  method nodes + method dispatch (`INFERRED`), const-arrow functions, alias resolution,
  builtins excluded, module projection, and **`generateCallGraph` on a hand-written AST
  (no parser)**. `npm run typecheck` clean.
- **`main.js` now generates + serializes the call graph:** zip → `graphify-out/callgraph.json`
  (+ printed summary and sample edges); single file → `<file>.callgraph.json`. Works under
  both `npx tsx main.js` and compiled `node dist/main.js`.
- Output matches the documented struct: `meta.counts`, nodes with `scope`, edges with
  `form`/`confidence`/`site`/`weight`, `unresolved` (with `reason`), optional `calls`
  records (`keepCallRecords`).

### Deviations / scope of v1
- Configs cover **python/js/ts/tsx/go**; other languages degrade to module + import nodes.
- **Method dispatch is name-based** (`INFERRED`/`AMBIGUOUS`) — the receiver `type_table`
  (tier-3 `EXTRACTED` via `d = Dog()`) is **not yet** built; `constructs` resolves the
  class, method calls resolve by unique method name.
- `inherits`/`implements` captured for python/JS best-effort; not yet used to expand
  virtual-dispatch override sets.
- `binds` edges and pipeline/curry `chained` returns are modeled in the types but not yet
  emitted; `returns`/`args` are captured in `CallRecord` (behind `keepCallRecords`).
- `output` dir renamed `graphify-out/` (was `graphify-ast-out/`); still gitignored.
