# Plan 12 — Common vs Business classification (split infrastructure from domain features)

**Status:** DRAFT / brainstorm. Not executed. Runs **after Plan 11** (vocabulary + domain) and
**before Plan 13** (interconnection splitting). Introduces a top-level tier in the output.

## Governing principle (overrides Plans 11–13): business-legible first, technical second

The breakdown exists for **product/business people first, engineers second.** Every level we emit —
tier → category → feature → operation — must be nameable in terms a non-technical product person
recognizes. **If a level is confusing or only describable technically, we don't emit it — we
collapse up a level.** Depth is *adaptive*, not fixed:

- **Never split for technical granularity's sake.** If breaking a feature into finer pieces (e.g.
  Plan 13 operation-level `findById`, or per-atom UI components) produces labels a PM wouldn't
  understand, **stop at the coarser level**. It is better to show a clear "Product" feature than a
  precise-but-confusing "ProductRepository.findById."
- **Business tier** goes as deep as stays legible — to features a PM knows (Cart, Checkout, Product
  Search), and to Plan 13 operation-level **only when the operations are themselves business-
  meaningful** (Apply Coupon, Track Order), not for plumbing CRUD.
- **Common tier** is technical by nature → default to **category-level** (Networking, Persistence,
  UI Kit). Emit common *features* only when they're a recognizable unit; otherwise the category (or
  even just the tier) is the leaf. Don't fragment infra into technical micro-features.
- **The test for any node:** *"Would a product person know what this is without asking an
  engineer?"* No → relabel, coarsen, or drop the level. This gate wins over any granularity rule in
  Plans 11–13.

**Decisions (locked):**
- **Nested schema (Option A).** The output nests two top-level tiers `business` / `common`, each
  its own `{ categories: [...] }` tree. This is a **breaking** top-level schema change — no
  backward compatibility with the old flat `categories[]` and **no `kol.json` compatibility** is
  maintained. A `meta.schemaVersion` bump signals the new format.
- **Common UI granularity = molecule level (per composed component), not atom.** In the Common
  tier, the UI feature unit is a **molecule/organism** — a component that *composes other
  components* (SearchBar, FormField, Card, Header). **Atoms** — leaf primitives that render only
  props/HTML (Button, Input, Spinner, Badge) — are **too granular to be features**; they roll up
  into a single `UI Primitives` bucket per category (and cross-link to the molecules that use them).
  Detection, in order: (a) explicit atomic-design dirs (`atoms/` vs `molecules/`/`organisms/`);
  else (b) structural — a component that imports/renders **no other local component** is an atom
  (leaf) → roll up; one that composes local components is a molecule+ → its own feature. This
  refines Plan 11, which collapses all of `atoms/molecules/organisms` to one `components` layer —
  Plan 12 must instead *distinguish* the atomic level to set granularity.
- **Non-UI / backend granularity = controller · business process · data model (never algorithm
  detail).** Break backend code only at those three units; internal algorithm steps are never a
  level. Specifically:
  - **APIs are always Common.** Endpoints / controllers / route handlers are the transport surface
    → Common tier. A route that *names* a capability (`/cart`, `/products/search`) is **evidence**
    the business feature exists (Plan 11 naming) — but the handler *code* is classified Common, and
    the business feature holds a `reference` to it. (Capability ≠ its API entry point.)
  - **Data models are Common but described *within* their business feature.** A `Product`/`Order`
    entity surfaces under the Product/Order business feature (cross-linked/included), not buried in a
    technical bucket — a data model is how a PM understands what a feature operates on.
  - **Reusable utility algorithms are Common — even business-flavored ones** (tax, shipping, discount
    calculators). They are shared computations features *use* (`uses` cross-link), not features
    themselves. The business process that *invokes* tax/shipping is the feature; the calculator is
    common infra it references.
- **Dynamic ubiquity trim → then bidirectional cross-links.** A runtime-built dictionary of
  ubiquitous symbols (logger, env, config, i18n — anything whose distinct-feature fan-in ≥
  `ubiquityThreshold`, default `max(5, ⌈0.5 × featureCount⌉)`) is **trimmed** from features and
  cross-links entirely (recorded once in `meta.ubiquitous`). **After** the trim, cross-links are kept
  **both forward** (`uses`) **and inverse** (`usedBy`) — clean because the noise is already gone.
  See the two sections below.

Introduces a top-level tier in the output:

```
Business
  └─ Category (Catalog, Cart & Checkout, …)
        └─ Feature (Product, Cart, Checkout)
Common
  └─ Category (Networking, UI Kit, Persistence, Auth, Config, Observability)
        └─ Feature (apiClient, design-system, db pool, logger)
```

## Why

Most of a codebase is **not** a business feature. HTTP clients, ORMs, design-system atoms, config,
logging, middleware, barrels, type contracts — this is **common / infrastructure** code. Plan 11
already sweeps a lot of it into a single `Core` bucket (54 of 180 modules on `sample_source_planout`),
which is a blunt admission that "this isn't a real feature." Plan 12 makes that split **first-class
and structured**: separate the common tier from the business tier, and give each its own
category→feature tree. Business features get the spotlight; common code is still catalogued (it
matters for architecture) but never masquerades as domain functionality.

This also feeds Plan 13: the common tier is largely the **connectors** Plan 13 wants to cut, and the
per-god-node `reference` flag defined here is exactly Plan 13's member-vs-connector signal.

## Can the AST tell if code is "common"? — yes

"Common" has a recognizable *structural fingerprint* the AST sees directly, independent of names.
Signals (combine — no single one is sufficient):

**Purely structural (AST alone):**
1. **Barrel / re-export files** — body is only `export … from` / `export { … }` (no declarations).
   Pure plumbing. AST: all top-level statements are re-exports.
2. **Type-only modules** — only `interface` / `type` / `enum` declarations, no runtime code.
   Contracts, not features. AST: declaration kinds ∈ {interface, type-alias, enum}.
3. **Config / constant modules** — only `const` literal object/array exports, no functions/classes.
   AST: exported bindings are all literals; zero call expressions.
4. **Presentational UI primitives** — a component that renders props with **no** calls to
   services/api/domain and **no** domain imports (Button, Spinner, Input). AST: JSX/return present,
   call-expressions only to framework/hooks, no edge to a domain module.
5. **Library adapters / thin wrappers** — imports are (nearly) all external packages and exports
   thinly forward them (axios→apiClient, sequelize→db). AST: import sources external; export bodies
   short and delegate.
6. **Framework-role markers** — decorators / conventional names for middleware, interceptor, guard,
   filter, pipe, resolver-glue. AST: `decorators` on the node (Plan 07 already extracts these).
7. **API / transport layer → always Common.** Endpoint / controller / route-handler definitions
   (route decorators `@Get`/`@app.route`/`router.post`, or `routes/`/`controllers/` layers, or
   handlers with a request/response signature). The HTTP surface is infrastructure; the *capability*
   it exposes is the business feature that references it. AST: route decorators + handler signature.
8. **Data model / entity → Common, but attributed to a business feature.** A class/schema/type that
   is a domain entity (ORM model, `@Entity`, a schema definition) is tiered Common by structure yet
   surfaced *within* its business feature (`dataModels: [...]`), because the model is how a PM reads
   what the feature operates on.

**Structural + graph (AST + call graph):**
9. **No domain vocabulary** — Plan 11 residue is empty / only generic role words (Client, Manager,
   Base, Util, Handler, Store, Provider). Already computed — the `Core` bucket is candidate-common.
10. **Broad cross-domain reuse** — a node with high fan-in from **≥k distinct business features /
    domain tokens** (an `apiClient.request` called by cart+product+order+auth). Domain-agnostic reuse
    ⇒ common. (This is the `reference` signal; see below.)
11. **`utilityHub`** (Plan 06) and **high betweenness** (Plan 13) — shared bridges, i.e. infra.
12. **Reusable computation** — a pure/near-pure algorithm reused by ≥k features, **even a
    business-flavored one** (tax, shipping, discount). Common utility; the invoking process is the
    feature. AST: pure function (no I/O/entity mutation) + multi-feature fan-in.

**Classification rule (proposed):** a feature/module is **Common** when it clears a weighted
threshold of the above (e.g. any strong structural signal 1–6, **or** ≥2 of 7–10). Otherwise
**Business**. Everything is `log()`-ed with its triggering signals so the threshold is tunable and
auditable — mis-tiering a real feature as "common" is the risk to watch.

## God nodes: `reference` vs not

Per the request, a god node must say whether it's a **reference** (shared/infra, consumed across the
system) or a **participant** in a business capability. Add to `GodNode` (Plan 06 `rank.ts`):

```ts
interface GodNode { /* …existing… */
  reference?: boolean;        // true = infra/shared (common tier); referenced broadly, not a domain capability
  referencedBy?: number;      // distinct business features/domains that call it (evidence)
}
```

`reference = true` when the node is `utilityHub`, or high-betweenness, or reused across ≥k distinct
domain tokens, or lives in a Common-classified module. A `reference` god node is a **hub of common
code**, not a business god node — so the two tiers rank their own god nodes separately (Business
features are anchored by domain god nodes; Common features by their infra hubs). This is the same
member/connector distinction Plan 13 uses to cut the graph — computed once here, consumed there.

## Dynamic ubiquity dictionary (frequency trim — runs *before* cross-linking)

Some common code isn't even worth showing as a dependency. Logging, env/config access, i18n
(`t()`), generic formatters (`formatDate`, `classNames`) are called from **everywhere** — if every
feature listed "uses logger," the graph is clutter a business person ignores. Imagine the doc: each
feature's dependency list drowning in `logger`, `getEnv`, `config.get`. So before cross-linking,
build a **dynamic** ubiquity dictionary and **trim** these out entirely.

- **Dynamic, not hand-authored.** The dictionary is derived at runtime from *this* codebase's actual
  usage (logger/env here, something else elsewhere) — though it re-discovers the usual suspects. It
  is the call-graph analogue of stop-words.
- **Metric = distinct-feature fan-in.** For each callee symbol/module, count how many **distinct
  features** reference it — *not* raw call count (a thing called 100× by one feature belongs to that
  feature; a thing called by 40 different features is ubiquitous).
- **Threshold, dynamic/relative — default `T = max(5, ⌈0.5 × featureCount⌉)`.** A symbol is
  *ubiquitous* when its distinct-feature fan-in ≥ T. The 50% fraction catches cross-cutters on large
  repos; the **absolute floor of 5** guards small repos (50% of 4 features = "used by 2" is not
  ubiquitous — the floor makes tiny codebases trim ~nothing, which is correct). Configurable via
  `ubiquityThreshold`: a fraction in `(0,1)` is read as "× featureCount," an integer ≥ 1 as an
  absolute count; the floor of 5 still applies. Trimming is destructive (hides a dependency), so the
  default errs conservative — trim only what is genuinely everywhere. The effective cutoff is
  `log()`-ed with the trimmed set.
- **Trim.** Ubiquitous symbols are **removed from feature membership and excluded from all
  cross-links**. They are recorded once — a flat `meta.ubiquitous: [...]` and/or a single Common
  "Platform Baseline" feature — never linked per-feature. This is the governing principle applied:
  a PM doesn't care that Cart uses the logger.

**Order:** classify tiers → build ubiquity dictionary → **trim** → *then* cross-link. Because the
noise is gone first, everything left is below threshold and human-recognizable.

## Cross-links (locked — computed after the trim)

Since ubiquity is trimmed first, the surviving dependencies are few and recognizable, so keep
**both directions** without flooding anything:
- **forward** `Feature.uses = [commonFeatureIds]` — Cart → API Client; Checkout → Tax Calculator,
- **inverse** `CommonFeature.usedBy = [featureIds]` — API Client → [Cart, Product, Order],
- **inclusion** `Feature.dataModels = [commonModelIds]` — Product feature ← its Product model.

Feature-level (not per-symbol) so the view stays legible; both directions stay clean precisely
because the ubiquitous plumbing was trimmed before this step.

## Output additions (data model)

```ts
type Tier = "business" | "common";
interface Feature { /* …Plan 11… */
  tier: Tier;
  commonSignals?: string[];      // why it was tiered common
  uses?: string[];               // forward cross-link → common featureIds (post-trim)
  usedBy?: string[];             // inverse cross-link ← featureIds (common features only)
  dataModels?: string[];         // data-model featureIds this feature operates on
}
interface Category { /* … */ tier: Tier; }

interface Grouping {
  business: { categories: Category[] };   // was: categories (flat) — REMOVED
  common:   { categories: Category[] };
  meta: { /* … */
    schemaVersion: number;
    businessFeatureCount: number;
    commonFeatureCount: number;
    ubiquityThreshold: number;   // effective distinct-feature fan-in cutoff = max(5, ⌈0.5·featureCount⌉)
    ubiquitous: string[];        // trimmed ubiquitous symbols (logger, getEnv, …)
  };
}
```

`category-feature.json` mirrors the two-tier shape. **This is a breaking schema change (locked):**
the top-level `categories[]` is gone, replaced by nested `business`/`common`. No back-compat and no
`kol.json` compatibility. Consumers that must be updated (all internal):
- `grouping.categories.flatMap(c => c.features)` → over `[...business.categories, ...common.categories]`
  in the LLM labeler (`llm.ts`), which pools/labels across both tiers uniformly.
- `toCategoryFeatureSummary` (`summary.ts`) emits the nested shape.
- `main.js` prints two tiered sections; `smoke.ts` assertions updated.
- `meta.schemaVersion` bumped so any downstream parser detects the new format rather than
  mis-reading the old one.

## Common category taxonomy (starter)

A small, extensible set of common categories (parallel to the domain dictionaries in `src/domain/`):
`API / Endpoints`, `Networking / API-Client`, `Persistence / DB`, `Data Models`, `UI Kit / Design
System`, `State / Store`, `Auth / Session`, `Config / Env`, `Observability / Logging`,
`Validation / Serialization`, `Routing / Middleware`, `Calculators / Utilities` (tax, shipping,
discount), `Types / Contracts`, `Build / Tooling`. Consider a `src/common/` taxonomy file mirroring
`src/domain/`.
Notes: `Auth` straddles — session plumbing is common, authorization *rules* are business (default
common unless coupled to a domain entity). `Data Models` are catalogued here **and** attributed to
the business feature they describe (`dataModels: [...]`), so a PM sees them in context.

## Pipeline placement

```
Plan 11 (vocabulary + domain)  →  Plan 12 (tier: business vs common, god-node reference flag)
   →  Plan 13 (split BUSINESS features into operations via connector cut)
```
Plan 12 runs on Plan 11's features: each feature (incl. the `Core` bucket, which is exploded into
real common categories) gets a `tier`. Plan 13 then only splits the **business** tier.

## Open questions — brainstorm

*Resolved (see Decisions): nested schema (Option A); UI granularity = molecule; backend granularity
= controller/process/model; cross-links = forward + inverse, computed after the ubiquity trim.*

1. **Auth / validation straddle.** Session/token plumbing = common; authorization *rules* = business.
   Split by AST (does it encode domain rules vs wrap a lib)? Or let it default to common? *Lean:*
   common unless it couples to domain entities.
2. **Threshold & precedence.** Which signals are "strong" (auto-common) vs "weak" (need ≥2)? Does a
   domain-named UI primitive (`ProductCard`) go common (presentational) or business (domain-named)?
   *Lean:* presentational-structure wins → common, but record the domain token as a cross-link.
3. **`src/common/` taxonomy** — hand-authored like domain dictionaries, or inferred purely
   structurally? *Lean:* small seed taxonomy + structural inference, same as domain.

*(Resolved: ubiquity threshold default = `max(5, ⌈0.5 × featureCount⌉)` distinct-feature fan-in,
configurable + `log()`-ed — see the Dynamic ubiquity section.)*

## Verification (definition of done)

1. On `sample_source_planout`: `Business` tier holds Cart / Product / Checkout / Catalog / …; the
   old `Core` blob is gone, replaced by a `Common` tier with categories like UI Kit (design-system
   atoms), Networking (`apiClient`), Persistence (repositories base/db), Config.
2. `apiClient.request` is a **Common** feature and its god node has `reference: true` with a
   `referencedBy` count > 1 domain — never a business feature.
3. A pure barrel/`index.ts` and a types-only file land in Common via their AST fingerprint (with
   `commonSignals`). Atoms (`Button`, `Input`, `Spinner`) roll up into **one** `UI Primitives`
   feature — **not** one feature each — while a molecule (`SearchBar`, `FormField`) is its own
   Common feature that cross-links to the atoms it composes.
4. A genuinely domain feature (`Cart`) is **not** mis-tiered as common even though it imports common
   infra.
5. **API/transport is Common:** `server/src/routes/*` and controllers land in a Common `API /
   Endpoints` feature, while the business capability they expose (Cart, Product Search) stays in the
   Business tier and holds a `reference` to the route.
6. **Business-flavored utilities are Common:** a tax/shipping/discount calculator is a Common
   `Calculators / Utilities` feature; the Checkout business feature `uses` it — the calculator is not
   itself a business feature.
7. **Data models attributed to features:** a `Product`/`Order` model is catalogued under Common
   `Data Models` **and** listed on its business feature via `dataModels`.
8. No level is emitted that a product person couldn't name (governing principle): no
   `findById`-style technical leaf appears as a feature in either tier.
9. **Ubiquity trimmed:** logger / env / config appear **once** in `meta.ubiquitous`, are absent from
   every feature's members and cross-links, and no feature lists "uses logger."
10. **Cross-links clean:** after the trim, `Cart.uses` and `apiClient.usedBy` each list only a
    handful of recognizable features — no ubiquitous plumbing.
11. Deterministic; two-tier `category-feature.json` validates; `businessFeatureCount` /
    `commonFeatureCount` / `ubiquityThreshold` reported in meta.

## Phasing

1. AST fingerprint detectors (barrel / types-only / config / presentational / adapter / decorator)
   over the serialized AST (Plan 03) + import IR (Plan 04). `log()` per-module signals on the sample.
2. Graph signals: `reference` flag on god nodes (utilityHub + betweenness + cross-domain fan-in).
3. Classifier: combine signals → `tier` per feature; explode Plan 11 `Core` into common categories
   (seed `src/common/` taxonomy).
4. **Dynamic ubiquity dictionary**: distinct-feature fan-in per symbol → trim ≥ `ubiquityThreshold`
   into `meta.ubiquitous`; `log()` the trimmed set for audit.
5. **Cross-links** (post-trim): forward `uses` + inverse `usedBy` + `dataModels`, feature-level.
6. Two-tier output + summary + meta counts; wire into `buildGrouping`.
7. Tune thresholds on the sample; confirm the verification cases; hand the Business tier to Plan 13.
