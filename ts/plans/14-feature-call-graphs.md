# Plan 14 — Per-feature code call graphs (depth-bounded, content-bearing, no LLM)

**Goal:** For each feature (and its Plan 13 operations), emit a **call graph you can actually read
the code from**: a rooted, depth-limited tree of nodes where every node carries the **real source
code** of that function/method — its title and content. **No LLM** — the code *is* the content;
this is about *seeing* the call graph, not summarizing it. Depth is capped so a deep chain stays
readable: past the cap you still see a node's **title and the calls it makes**, but not its body.

Runs after Plans 11–13 (they define the features, tiers, and operation roots). Output is a set of
per-feature graphs written alongside `grouping.json` — a debugging/inspection artifact.

## Why

`category-feature.json` tells you *what* the features are; it doesn't let you *see the code*. To
verify a feature ("is Update Product really update→findById→save?") or hand a reviewer the concrete
implementation, we want the call graph **with the code inlined per node**, bounded so it doesn't
explode into an unreadable 12-level tree. This is the missing "show me the actual code behind this
capability" view — and a natural place to later drop in Plan 09-style LLM summaries per node.

## Roots — where each graph starts

Per business feature, one call tree **per operation** (Plan 13), rooted at the operation's **entry
symbol** (`ProductService.updateProduct`). Fallbacks when a feature has no operations: the feature's
**god nodes** (Plan 06), else its **exported/public** symbols, else every top-level def in its
modules. A feature therefore yields *N* small trees (one per operation), not one giant graph —
already a readability win.

## Traversal & the depth cap (the core rule)

Walk `calls` + `passes` edges (Plan 04) from each root, breadth-first, assigning a `depth`:

- **depth 0** (root) … **depth < N**: **expanded** — node carries full `content` (source) **and**
  its children are walked.
- **depth == N** (the **frontier**): node is **truncated** — it carries its **title** and its
  **outgoing call list** (the callee titles / edge labels) so you can see *that* it calls further
  and *what* it calls, but **no `content` and no children**. This is the "even if the call goes N
  deep, just show the title and the function call" rule.
- **Cycles / re-use:** a callee already expanded elsewhere in this tree is emitted as a
  **reference** (`ref: true`, title + edge only) — never re-expanded, so recursion and shared
  helpers can't blow up the graph.

`N` defaults to **2** (root + 2 levels), configurable (`maxDepth`). The frontier always shows edges,
so nothing is silently hidden — you always know a deeper call exists, you just don't get its body.

## Node content

Content is the **literal source slice** of the symbol, from its Plan 04 span:
`source.slice(node.startIndex, node.endIndex)`, read from the extracted file (`join(rootDir,
relPath)` — main.js already has `prepared.rootDir`). Guards for readability:
- **Truncate long bodies** to `maxContentLines` (default 40) / `maxContentChars` (default ~2000),
  appending `… (+K lines)` — a 300-line function shouldn't dominate.
- **Title** = `qualifiedName` + `kind` + `file:line` (e.g. `ProductService.updateProduct  (method)
  · services/ProductService.js:42`).
- Distinct symbols sharing a qualifiedName (see the `contentService.delete` case) are disambiguated
  by `file:line` in the title.

## Output format — a folder per feature, grouped by tier

Output lives under `graphify-out/feature-graphs/`, split by tier, then **one folder per feature**
(named by the feature label slug), each holding its call-graph JSON — a browsable, debuggable tree:

```
graphify-out/feature-graphs/
  business/
    product/        graph.json        ← this feature's call graph (all its operation trees)
    cart/           graph.json
    coupon/         graph.json
  common/
    api-client/     graph.json
    rest-routes/    graph.json
    ui-primitives/  graph.json
  index.json                          ← manifest: tier → feature → path, label, counts
```

- Folder name = `slug(feature.label)` (e.g. `Product` → `product`, `API Client` → `api-client`),
  deduped with a numeric suffix on collision.
- Each feature folder contains **`graph.json`** = the `FeatureCallGraph` for that feature (its
  operation trees + nodes with inlined source). Content is heavy, so this stays out of the main
  `grouping.json` / `category-feature.json`.
- Optional: also emit one file **per operation** inside the folder
  (`business/product/update-product.json`) when a feature has many operations — a `perOperationFiles`
  flag; default is the single `graph.json`.
- `index.json` at the root maps `tier → [{ featureId, label, dir, operationCount, nodeCount }]` so a
  tool can enumerate without walking the tree.

```ts
interface CodeNode {
  id: string;                 // symbol node id
  title: string;              // qualifiedName + kind + file:line
  file: string; line: number; kind: string;
  depth: number;
  tier?: "business" | "common";     // Plan 12 — mark where a call leaves into infra
  content?: string;                 // source slice; omitted when truncated/ref
  truncated?: boolean;              // depth == N: title + calls only
  ref?: boolean;                    // already expanded elsewhere → shown as reference
  calls: { to: string; title: string; kind: string }[];  // outgoing edges — ALWAYS present
}
interface OperationGraph { root: string; label: string; maxDepth: number; nodes: CodeNode[]; }
interface FeatureCallGraph {
  featureId: string; label: string; tier: "business" | "common";
  operations: OperationGraph[];     // one rooted tree per Plan 13 operation (or fallback roots)
  meta: { maxDepth: number; nodeCount: number; truncatedCount: number };
}
```

`calls` is present on every node (including frontier/ref) so the edge structure is complete even
where content is withheld. `tier` lets a reader see when a call crosses from business logic into a
common accessor (`updateProduct → CartRepository.save`).

## Config

```ts
interface CallGraphViewOptions {
  maxDepth?: number;         // default 2
  maxContentLines?: number;  // default 40
  maxContentChars?: number;  // default 2000
  edgeKinds?: EdgeKind[];    // default ["calls","passes"]
  crossTier?: boolean;       // default true — follow calls into the common tier (marked), else stop
  includeContentAtFrontier?: boolean; // default false — the depth-cap rule
}
```

## Readability guarantees (why it won't be a wall of text)

1. **Depth cap N** — the primary control; frontier = title + calls only.
2. **Per-operation roots** — many small trees, not one hairball.
3. **Content truncation** — long bodies clipped with a `+K lines` marker.
4. **Dedup by reference** — shared helpers/cycles shown once.
5. **Tier marking** — calls into common infra are visible but flagged, and (optionally) not
   followed (`crossTier: false`) so a feature graph stays within its own logic.

## No LLM now / LLM later

Content is raw code today (the ask). The `CodeNode` shape is LLM-ready: a later pass (reuse Plan 09
streaming) can fill a `summary` field per node from `content`, or replace the frontier's edge list
with a one-line natural-language description — without changing the graph structure.

## Verification (definition of done)

1. On `sample_source_planout`, `feature-graphs/business/product/graph.json` exists (and
   `feature-graphs/common/api-client/graph.json`, etc.) with one operation tree per Product
   operation; the `Update Product` root shows the **actual `updateProduct` source** as `content`,
   and its call to the repository appears as a child (or, at the cap, as a frontier edge with the
   callee title). `index.json` lists every feature under `business`/`common`.
2. No tree exceeds `maxDepth`; every node at the cap has `truncated: true`, no `content`, and a
   non-empty `calls`.
3. Deep/recursive chains terminate (refs), no duplicate expansion, deterministic output.
4. A node's `content` matches the file's bytes at its span (spot-check `updateProduct`).
5. Content over `maxContentLines` is clipped with a `… (+K lines)` marker.

## Phasing

1. Source-slice helper: given the call graph + `rootDir`, read a node's file and return its
   (truncated) source by span. Cache per file.
2. BFS walker with the depth cap + ref/cycle dedup → `OperationGraph` from a root.
3. Per-feature assembly (roots from Plan 13 ops / god-node fallback) → `FeatureCallGraph`.
4. Writer: `feature-graphs/<tier>/<feature-slug>/graph.json` + root `index.json`; wire into main.js
   (after grouping). Create tier + feature dirs; dedupe slug collisions.
5. Verify on the sample; tune `maxDepth` / truncation for readability.
