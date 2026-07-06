# Plan 13 — Interconnection-based feature splitting (features = connected logic, not shared nouns)

> Runs **after Plan 12** (Common vs Business classification): Plan 12 separates common/infrastructure
> code from business code and marks each god node as a `reference` (shared/infra) or a member. Plan 13
> takes the **Business** subset and splits it into operation-level features by cutting connectors —
> which are largely the same nodes Plan 12 already marked `reference`.

**Status:** DRAFT / brainstorm. Not executed. This plan critiques Plan 11's lexical clustering
and proposes call-graph interconnection as the real feature boundary. Three core decisions are
now **locked** (see "Decisions"); the rest of "Still open" is the remaining brainstorm.

> **Legibility gate (from Plan 12's governing principle — overrides granularity here):** split to
> operation-level **only when the operations are business-meaningful** (Apply Coupon, Track Order).
> If the split would produce technical/plumbing labels a product person wouldn't recognize
> (`findById`, `save`), **stop at the coarser feature** — a clear "Product" beats a precise but
> confusing "ProductRepository.findById." Business-legible first, technical second.

**Decisions (locked):**
- **Operation-level granularity (gated by legibility above).** Independent operations are
  independent features **when the operation itself is business-meaningful**. A page/route that uses
  several operations does **not** own them — it holds a **reference** to each feature it consumes
  (`references: [featureIds]`). Ops merge back into one feature when they interconnect *and* share a
  canonical name — **or** when splitting them would only expose technical plumbing.
- **Connector detection includes betweenness now** (Brandes, sampled/approximate) alongside
  degree-percentile, `utilityHub`, and role/decorator hints.
- **Cores = connected components, with Louvain as the tiebreaker** for borderline merges/splits.

## The problem (observed in `category-feature.json`)

Plan 11 clusters modules by a shared **domain noun**. That is *lexical*, not *logical*. Result:

```json
{ "id": "cat:catalog/product", "label": "Product Management", "moduleCount": 6,
  "godNodes": ["productService.delete", "ProductRepository.findById", "ProductService.updateProduct"] }
```

`delete`, `findById`, `updateProduct` are **three independent operations** that merely share the
noun "product" and are each reused by the page. They do not form one interconnected capability —
they're a CRUD *toolbox*. Lumping them into one "Product" feature loses the real structure.

**The user's definition of a feature: interconnected logic.** God nodes that actually call /
depend on each other belong together; god nodes that are independent (each invoked separately by
a page or an API controller) are separate features. A reused connector (API controller, shared
`findById`, HTTP client) must **not** be the thing that glues unrelated operations into one blob.

## The principle

> A feature is a **maximal connected subgraph of domain logic** in the call graph, after the
> **connector nodes** (the things reused *across* features) are removed. Vocabulary (Plan 11 A/C)
> then **names** each subgraph; it no longer *defines* the boundary.

Two node roles, decided structurally:
- **Member** — participates in one capability's internal call chain (`updateProduct → findById →
  save`). Interconnected members = one feature.
- **Connector** — bridges many capabilities: UI pages/routes/controllers (high fan-out to
  unrelated ops), shared accessors like `findById` (high fan-in from unrelated ops), utility hubs
  (`apiClient.request`), framework glue. Connectors are the *reason* a naive component walk sees
  one giant blob. **Cut them, and the blob falls apart into the real features.**

The whole game is **identifying connectors correctly**. Cut too much → everything fragments into
singletons; cut too little → one "Product" blob remains. This is the classic
betweenness/articulation-point problem, and we already have most of the machinery (see below).

## Worked example — what "good" looks like

Nodes & `calls` edges around Product:
```
ProductPage ─┬─▶ ProductService.getProduct ──▶ ProductRepository.findById
             ├─▶ ProductService.updateProduct ─▶ ProductRepository.findById, .save
             └─▶ ProductService.deleteProduct ─▶ ProductRepository.deleteById
```
- **Naive connected components:** all reachable from `ProductPage` → 1 feature (today's blob).
- **Cut connectors** (`ProductPage` = page/high fan-out; `ProductRepository.findById` = high
  fan-in, reused by get+update) → components split:
  - `{ getProduct }` , `{ updateProduct, save }` , `{ deleteProduct, deleteById }`
- **Name via Plan 11 A/C:** → **Product Read**, **Product Update**, **Product Delete** under
  category **Catalog** (domain=ecommerce). `findById` becomes a *shared* Catalog accessor, not a
  feature. `ProductPage` becomes a *composition* node (records which features it wires together).

That matches the user's intuition: distinct reused operations = distinct features; the page is a
consumer that composes them, not a feature that owns them.

## What we already have to build on

- `rankGodNodes` (Plan 06) already computes in/out degree over `calls`+`passes`, flags
  `utilityHub` (broad fan-in / low fan-out leaf), and supports `excludeHubPercentile` — a
  ready-made **connector detector** by degree percentile.
- `detectCommunities` (Plan 08, `group/community.ts`) — deterministic confidence-weighted Louvain;
  currently module-level and used only as a *validator*. Plan 13 promotes interconnection to a
  *definer* and (option) runs it at **symbol** granularity.
- Call graph carries `calls`/`passes`/`constructs` edges with `confidence` + `weight`, and node
  `decorators` / `exported` (route/entry hints) — the connector signals.
- Plan 11 `detectFeatures` (vocabulary + domain dictionaries) — reused purely for **labeling**
  the resulting components and canonicalizing to domain vocab.

## Proposed algorithm (symbol-level, then projected to modules)

1. **Build the symbol graph.** Nodes = functions/methods/classes (exclude modules/externals).
   Edges = `calls` + `passes` (drop `contains`/`imports`), confidence-weighted like Louvain.
2. **Score connectorness** per node (combine all signals — locked to include betweenness):
   - **betweenness** (bridges many pairs) — primary structural signal; Brandes, **sampled** on a
     node subset / approximated on large graphs to bound the O(V·E) cost,
   - degree percentile (top-p fan-in **or** fan-out) — reuse `excludeHubPercentile`,
   - `utilityHub` flag,
   - role/decorator hints: page/route/controller/handler/middleware (entry connectors),
   - fan-in from **≥k distinct domain tokens** (a `findById` pulled by cart+product+order is shared).
   A node is a connector if it clears a combined threshold (betweenness OR degree/role) — tuned on
   the sample corpus, cut set always `log()`-ed for inspection.
3. **Cut connectors** (remove, or set edge weight→0 through them). Keep the cut set aside.
4. **Find feature cores** among remaining nodes: **connected components** (primary), with
   **Louvain as the tiebreaker** — Louvain arbitrates only borderline cases (a component that a
   single low-confidence edge merged, or a large weakly-linked component that modularity would
   split). Each resulting core = a candidate feature.
5. **Re-attach connectors by role, never as members:**
   - a **page / route / controller** (entry connector) becomes a **consumer** node that holds
     `references: [featureIds]` — the operations it wires together (per the locked decision: the
     page references features, it doesn't own them),
   - a **shared accessor / util** records `sharedBy: [featureIds]` (see Still-open #1 for whether it
     also becomes its own "shared" feature).
6. **Label & canonicalize** each core with Plan 11 Pillar A/C (dominant token → domain canonical).
   Merge cores only when they share a canonical **and** are interconnected (guard over-fragmentation).
7. **Project to modules** for the existing `category → feature → module` output; a module can now
   map to several features (it hosts several operations) — or we keep one-primary (open question).

## How it composes with Plan 11

Plan 11 stays as the **naming + domain layer**; Plan 13 replaces the **boundary**:

```
symbol graph → connector cut → components (Plan 13)   ← feature BOUNDARY
      → vocabulary token + domain canonical (Plan 11 A/C)   ← feature NAME
      → community validation / cohesion / flags (Plan 08)   ← QA
```

Fallback: if the call graph is too sparse/low-confidence (e.g. mostly dynamic dispatch, or a
frontend-only leaf tree with no internal calls), interconnection yields singletons → **fall back
to Plan 11 vocabulary clustering**. Both cuts coexist; pick per-corpus by graph density.

## Output additions (data model)

```ts
interface Feature { /* …Plan 11 fields… */
  ops?: string[];               // member symbol ids forming the interconnected core
  sharedBy?: string[];          // connector accessors this feature reuses (annotation)
}
// A page/route/controller is a CONSUMER, not a feature member:
interface Consumer {
  id: string;                   // the page/controller symbol id
  kind: "page" | "route" | "controller" | "cli" | "job";
  references: string[];         // featureIds it wires together (locked decision)
}
// grouping.meta gains: { connectorsCut: string[]; consumers: Consumer[] }
```

The `references` edge is the key new relationship: `ProductPage.references = [product-read,
product-update, product-delete]` — the page *uses* those features without owning any of them.

## Still open (remaining brainstorm)

1. **Shared node ownership.** Is a reused `findById` (a) its own "shared accessor" feature, (b) a
   non-feature annotation (`sharedBy`), or (c) a member of *every* feature that calls it?
   *Lean:* (b) by default; promote to (a) only if it's large/interconnected on its own.
2. **Overlap.** Operation-level splitting means a service file hosts read+update+delete, so a
   module maps to several features. *Lean:* allow overlap at symbol level; report module→features
   as a set, pick a primary for the tree view.
3. **Cross-noun features.** Interconnection can bind two nouns (`Checkout → Payment → Order`).
   Cross vocabulary clusters when logic is tightly coupled? *Lean:* yes — the payoff of
   graph-over-lexical; the domain/LLM layer names the merged capability.
4. **Confidence floor.** Dynamic/`AMBIGUOUS` edges are where interconnection is least reliable.
   *Lean:* weight by confidence (as Louvain already does) + a min edge weight to keep a component
   together; connectors cut only on the reliable edges.
5. **Naming an operation feature.** `updateProduct` → "Product Update" needs a verb+noun label,
   not just the noun. Derive the verb from the entry symbol name (update/get/delete/create) and let
   Pillar C supply the noun/category. Open: how to name a multi-symbol chain with no clear head.

## Risks

- **Over-fragmentation** — the biggest one. Operation-level + aggressive connector cuts → a swarm
  of singletons. Mitigate with merge-by-canonical, `minFeatureSize`, and reporting what was cut.
- **Connector threshold sensitivity** — percentile choice swings results. Needs the sample corpus
  as a tuning fixture and a `log()` of the cut set for inspection.
- **Graph quality bound** — features are only as good as Plan 04/05 resolution. Frontend JSX trees
  (few internal calls) barely interconnect → vocabulary fallback carries them.
- **Betweenness cost** on large graphs — sample or approximate (Brandes on a node subset).

## Verification (definition of done, once we agree the approach)

1. On `sample_source_planout`, the `Product` blob splits into **business-meaningful** operations
   (e.g. Update Product, Delete Product), each a coherent call chain — while technical accessors
   (`findById`, `save`) do **not** become their own features (legibility gate): they stay shared
   references. `ProductPage` appears as a **consumer** with `references` to the features, not as an
   owner/member. Result is legible to a product person, not three raw god nodes under one label.
2. A reused connector (`apiClient.request`, a shared repository accessor) is **not** a feature and
   is not the sole link merging unrelated ops.
3. A genuinely cohesive capability (ops that truly chain) is **not** over-split.
4. Cross-noun tightly-coupled logic (`Checkout`+`Payment`) may form one feature when interconnection
   warrants — and the cut set is logged.
5. Deterministic; graph-sparse corpora fall back to Plan 11 vocabulary cleanly.

## Phasing (proposal)

1. Symbol-graph builder + connectorness scorer: **betweenness (Brandes, sampled)** + degree/hub
   (reuse `rankGodNodes`) + role/decorator hints. `log()` the cut set on the sample corpus —
   **inspect before wiring** (this validates the whole idea before any output changes).
2. Connector cut → **connected components (primary) + Louvain tiebreak** → cores; extract
   **consumers** (pages/routes) with `references: [featureIds]`; project to modules (with overlap).
3. Label via Plan 11 A/C, incl. **verb+noun** op names (update/get/delete + canonical noun);
   merge-by-canonical guard against over-fragmentation.
4. Community/cohesion validation (Plan 08) + fallback-to-vocabulary on sparse/low-confidence graphs.
5. Tune betweenness/degree thresholds against the sample; confirm `Product` splits into ops and the
   page shows up as a consumer referencing them.
