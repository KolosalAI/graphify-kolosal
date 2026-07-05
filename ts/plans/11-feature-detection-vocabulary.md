# Plan 11 — Language-Agnostic Feature Detection (Pillar A: vocabulary clustering → refined by Pillar B)

**Goal:** Detect real product features — `Cart`, `Homepage`, `Product Search`, `Checkout` —
in **any language and any project layout**, replacing Plan 08's folder-`L1` feature cut
which only works on feature-sliced repos. **Pillar A (domain-token clustering)** is the core,
zero-config detector. Once it produces features, **Pillar B (entry-point slices)** refines
and double-checks them. The **fuse-and-validate** of A + B is what the pipeline consumes.

## Why this exists (the observed failure)

On `sample/sample_source_planout` (a layered React + Node app), the current grouping
produced features `Src`, `Test`, `Core` — the **layers**, never Cart/Home/Search. Evidence:
`client/src/pages/CartPage.jsx` collapses into feature `Src` (category=`client`,
feature=`src`); god nodes surface `apiClient.request` (in-degree 588) and repositories, never
the JSX-rendered page components (in-degree ≈ 0). **Folders slice by layer; god nodes rank
plumbing.** Neither can see a feature. See [Plan 08 gap review](08-logical-grouping.md).

## The core idea — features are rows, layers are columns

A feature is a **vertical slice that crosses layers, named by the same domain noun in every
language**:

| Language | Files that are all "Cart" |
|---|---|
| JS/TS | `components/CartPage.jsx`, `services/cartService.ts`, `hooks/useCart.ts` |
| Python | `routes/cart.py`, `services/cart_service.py`, `models/cart.py` |
| Java | `CartController.java`, `CartService.java`, `CartRepository.java` |
| Go | `cart/handler.go`, `cart_repo.go` |
| Ruby | `cart_controller.rb`, `cart.rb` |

The folder differs; the token **`cart` is invariant**. Cluster by that token, not the folder.

---

## Pillar A — Vocabulary clustering (core, zero-config, all languages)

Purely lexical over identifiers/paths — no language or framework knowledge required.

### 1. Tokenize each module
Sources: path segments (after stripping the common prefix and known **layer dirs**),
filename stem, and the module's **top god-node symbol names** (from Plan 06). Split
camelCase / snake_case / kebab-case, lowercase, drop single chars and digits-only.

### 2. Strip role/layer affixes → the **domain term**
The one small, cross-language list (extensible): `controller, service, svc, repository, repo,
handler, model, dto, entity, view, page, screen, component, widget, hook, use*, manager,
provider, store, api, client, route, router, middleware, util, helper, config, index, main,
app, base, common, types`. What remains is the domain noun:
`CartPage → cart`, `cart_service.py → cart`, `CartRepository.java → cart`,
`useCart → cart`, `ProductSearchPage → product search`.

Multi-token residue (`product search`) is kept as an ordered n-gram so `ProductSearchPage`,
`searchProducts`, `product_search_service` co-cluster.

### 3. Cluster by domain term, score by **cross-layer spread**
Group modules sharing a primary domain term. Score each cluster:
- **`crossLayerSpread`** = number of distinct layer dirs it appears in (`pages` + `services`
  + `repositories` + `routes` → 4). A term in ≥2 layers is a **high-confidence feature**;
  a single-file term is weak.
- **size**, and **god-node presence** (does the cluster own a real symbol?).

Keep clusters with `spread ≥ 2` or `size ≥ minFeatureSize` as features; singletons/leftovers
fold into a per-category `Core`/`Misc` bucket (not their own features).

### 4. Category reconciliation (features now cross folders)
Token features span layers, so the folder can't be the parent. Assign each feature to a
**category** by (in order): (a) a coarser domain grouping — cluster feature *tokens* by
co-occurrence in the call graph / shared broader noun (`Cart`+`Checkout`+`Order` → "Commerce";
`Login`+`Auth`+`Token` → "Identity"); else (b) the dominant top-level app area of its modules
(`client`/`server`). Category labels are finalized by the LLM (Stage 5). A module belongs to
**one** feature (its primary token); a feature belongs to one category.

**Output of Pillar A:** a category → feature → module tree where features are domain tokens
with cross-layer members and a `confidence` from spread/size. This alone should surface
Cart/Home/Search/Product on `sample_source_planout`.

---

## Pillar B — Entry-point slices (refinement / double-check, config-extensible)

Run **after** Pillar A to validate and sharpen it — not as the primary detector.

- **Detect entry points** via a small per-framework pattern registry (same shape as Plan 04
  `CallGraphConfig` / Plan 07 `testFilePatterns`): `route(...)`, `@app.route`, `router.post`,
  `@GetMapping`, gRPC service methods, `@click.command`, page-by-convention dirs. Name each by
  its **route path** (`/products/search` → "Product Search") — itself language-agnostic.
- **Membership = call-graph reachable slice** from the entry point (reuse Plan 07 roots +
  reachability). Fully generic given the graph.

Pillar B does four things to Pillar A's clusters:
1. **Validate** — a token cluster that matches an entry-point slice gains confidence.
2. **Split** — one token cluster spanning two distinct routes → two features.
3. **Merge** — two token clusters inside one route slice → one feature.
4. **Name & recover** — supply a route-based name; surface a feature A missed (entry point
   whose files share no token).

---

## Fuse & validate — what the pipeline consumes

The output is **neither A nor B alone** — it's their reconciliation:

1. **Overlap merge:** for each (A token-cluster, B entry-slice) pair, compute Jaccard over
   member modules. High overlap → one feature (prefer the route name; keep the token as an
   alias). A-only clusters survive on cross-layer spread; B-only slices survive on
   entry-point evidence.
2. **Confidence:** `high` = A∩B agree; `medium` = strong A (spread ≥ 2) or a clear entry
   slice; `low` = singleton/weak.
3. **Community validation:** run community detection (Plan 08 Stage 4) as a *check* — a
   feature whose members scatter across unrelated communities gets a `low-cohesion` flag, not
   a veto.
4. **LLM labeling** (Stage 5): name/describe each fused feature and group features into
   categories; merges/splits it proposes are advisory.

The fused, validated, labeled feature set flows into the existing `category → feature →
module` output and `category-feature.json`.

---

## Pillar C — Domain-dictionary enforcement (runs on the fused A+B output)

Pillars A+B discover features from the code; Pillar C **canonicalizes them against a base
dictionary of the codebase's business domain** so the output uses stable, human-recognizable
vocabulary. It runs **after the A+B fuse** and only when a domain is confidently detected — it
augments labels/categories, it never invents features that aren't in the code.

**Base dictionaries live in `src/domain/`** (created): `ecommerce.ts`, `banking.ts`,
`travel.ts`, a shared `types.ts`, and `index.ts` (registry + pure helpers). Each dictionary is
a list of canonical features with keyword synonyms and a canonical category:

```ts
interface DomainFeature { canonical: string; keywords: string[]; category: string; }
interface DomainDictionary { domain: string; label: string; features: DomainFeature[]; }
// e.g. ecommerce: { canonical: "Cart", keywords: ["cart","basket","bag","shoppingcart"], category: "Cart & Checkout" }
```

### How it enforces (after A+B)

1. **Detect the domain** — `detectDomain(allCorpusTokens)` scores each dictionary by keyword
   overlap; picks the top domain above a threshold, else **no enforcement** (don't force
   e-commerce vocab on an unrelated app).
2. **Canonicalize features** — for each fused feature, map its `domainToken`/`aliases` via
   `canonicalFeature(token, domain)`; on a hit set `label = canonical` (e.g. `basket`/`bag` →
   **"Cart"**, `productsearch` → **"Product Search"**) and bump confidence to `high`. Record
   the original token in `aliases`.
3. **Canonicalize categories** — assign the feature to the dictionary's canonical category
   (e.g. `Cart → "Cart & Checkout"`), giving a stable, domain-standard `category → feature`
   grouping instead of ad-hoc folder/app-area names.
4. **Gap note (advisory):** dictionary features with **no** matching code are reported as
   "expected but not found" in meta — never materialized as empty features.

### Order & precedence

`A (tokens) → B (entry-point refine) → fuse → C (dictionary canonicalize) → community validate
→ LLM label`. Precedence for the final label: **route name (B) > dictionary canonical (C) >
token (A)** — the dictionary standardizes, but a concrete route path still wins. Unmatched
features keep their token/route label; the dictionary is **additive, never suppressive**.

### API (from `src/domain/`)

```ts
detectDomain(tokens, minScore=3): { domain, score, matched[] } | null
canonicalFeature(token, domain): DomainFeature | null
domainCategories(domain): string[]
// registry: DOMAINS = [ECOMMERCE, BANKING, TRAVEL]; extend by adding a dictionary file.
```

New domains = drop a `src/domain/<x>.ts` into the registry — no engine changes.

### Scaling detection past ~5–6 domains

The "add a file" ergonomics hold at any N, but `detectDomain`'s **winner-take-all scoring
by a single scalar** does not degrade gracefully as dictionaries multiply and overlap.
Every domain shares generic tokens (`payment`, `account`, `auth`, `user`, `search`,
`review`), so as N grows those shared hits inflate every score roughly equally and the
*margin* between the top two domains collapses — a fintech-flavored healthcare app could
tie or flip. And `canonicalFeature` trusts whatever domain detection picked, so a wrong
pick canonicalizes confidently wrong (`bag` → Cart in ecommerce vs. Baggage in travel;
`card` banking vs. a UI card). Harden `detectDomain` **before** adding the 5th–6th
dictionary (backward-compatible signature — extra fields are additive):

1. **Inverse-domain-frequency keyword weights.** Precompute, across `DOMAINS`, how many
   dictionaries each normalized keyword appears in; weight a hit by `1 / domainFreq(kw)`
   (or `log`). A keyword unique to one domain counts full; a keyword in many counts little.
   Score becomes the summed weight of distinct matched canonical features, not a raw count.
2. **Expose the runner-up margin.** Return `{ domain, score, margin, matched[], runnerUp? }`
   where `margin = best.score - secondBest.score`. When `margin` is below a threshold
   (near-tie), treat as **uncertain** → return `null` (fall back to A+B tokens / LLM) rather
   than committing to a coin-flip. Keeps the existing `null`-means-don't-force contract.
3. **(Optional) Keep a small per-domain set of "signature" keywords** (`kyc`, `aml`, `sku`,
   `boardingpass`, `itinerary`) weighted extra, so a domain is recognized by its distinctive
   vocabulary rather than its generic overlap.

This is ~15 lines in [`src/domain/index.ts`](../src/domain/index.ts) and leaves the
dictionary files and `canonicalFeature`/`domainCategories` untouched. Until a real 5th+
domain lands, the current count-based `detectDomain` is sufficient (ecommerce/banking/travel
are distinct enough); revisit at that point, not before.

---

## Config (per grammar key + global defaults)

```ts
interface FeatureConfig {
  roleAffixes?: string[];       // extra role words to strip (merged with shared defaults)
  layerDirs?: string[];         // pages, components, services, repositories, routes, models, hooks, middleware, db, utils
  stopTokens?: string[];        // index, main, app, common, base, util, types, config
  minFeatureSize?: number;      // default 1 when crossLayerSpread≥2, else 2
  // Pillar B (refinement) — optional; absent → Pillar A only, graceful:
  featureHoldingDirs?: string[];
  entryPointPatterns?: RegExp[];
  routeName?: (raw: string) => string;
}
```

No config for a language → **Pillar A runs anyway** (naming clustering is universal). Config
present → Pillar B refinement activates.

## Output additions (per feature)

```ts
interface Feature {
  // …existing (label, description, modules, godNodes, cohesion, flags)…
  domainToken?: string;                 // "cart", "product search"
  aliases?: string[];                   // other tokens/route names merged in
  canonical?: string;                   // Pillar C dictionary label, when matched
  domain?: string;                      // detected domain: "ecommerce" | "banking" | …
  source: "token" | "entry-point" | "token+entry" | "dictionary" | "folder-fallback";
  confidence: "high" | "medium" | "low";
  evidence: { crossLayerSpread: number; entryPoints?: string[] };
}
// grouping.meta gains: { domain?: string; domainMatched?: string[]; expectedNotFound?: string[] }
```

## Verification (definition of done)

1. **The failing case fixed:** on `sample/sample_source_planout`, features include **Cart,
   Homepage, Product (Product Detail), Product Search** — each with **cross-layer members**
   (a `client/src/pages/*` file + related `server` route/service where present), not a single
   `Src` blob.
2. **Cross-language:** a fixture mixing JS/TS + Python + Java where `cart` appears as
   `CartPage.jsx` + `cart_service.py` + `CartController.java` → **one** `Cart` feature.
3. **No false merges:** `Cart` and `Checkout` stay separate; `order` (Order entity) not merged
   with an `orderBy`/sort util (stop-token + role-strip guards).
4. **Zero-config path:** Pillar A alone (no `entryPointPatterns`) still produces the features;
   Pillar B, when configured, raises their `confidence` to `high` and fixes any split/merge.
5. **Fuse precedence:** a token cluster matching a route slice yields one feature named from
   the route; A-only and B-only features both survive with correct `source`/`confidence`.
6. **Determinism:** same inputs → identical `category-feature.json` (stable ids, tie-breaks).
7. **Pillar C enforcement:** on `sample_source_planout`, `detectDomain` returns `ecommerce`;
   `Cart`/`Product Search`/`Homepage` carry `canonical` + `domain:"ecommerce"` and canonical
   categories (`Cart & Checkout`, `Catalog`); `basket`/`bag` tokens canonicalize to `Cart`;
   an unrelated corpus yields `detectDomain → null` and **no** enforcement (labels unchanged).

## Risks / open questions

- **Homonyms / generic tokens:** `order` (entity vs sort), `list`, `handler`. Mitigate with
  stop-tokens, role-strip, and requiring cross-layer spread for feature status.
- **Multi-token names:** `ProductSearchPage` → `product` vs `search` vs `product search`.
  Keep the ordered n-gram; let Pillar B route names and the LLM disambiguate.
- **Category reconciliation** is the genuinely new bit — features cross folders, so the parent
  can't be a folder. Start with app-area majority + LLM grouping; may need iteration.
- **Role-affix list maintenance** is the one shared knob; keep it small, extensible, and
  documented. Non-domain-named codebases (generated/obfuscated) weaken A → lean on Pillar B
  entry points and community detection.
- **God nodes stay anchors, not detectors** — never rank features by degree; frontend features
  are structural leaves.

## Phasing

1. **Pillar A core:** tokenizer + role-affix strip + `token → modules` map (zero-config).
2. **Cluster + score** (cross-layer spread) → features; **category reconciliation**; wire into
   `buildGrouping` to **replace the folder-L1 feature cut**. Verify Cart/Home/Search on
   `sample_source_planout`.
3. **Pillar B:** entry-point config + reachability slices; refine A (validate/split/merge/name).
4. **Fuse:** overlap merge + `confidence` + `source`; **community validation**; feed the tree.
5. **Pillar C:** `src/domain/` dictionaries (**created**: ecommerce/banking/travel) +
   `detectDomain`/`canonicalFeature`; enforce on the fused output (canonicalize labels +
   categories, gap note). Precedence route > dictionary > token.
6. **LLM labeling** of fused features + category grouping (reuse Stage 5).
7. Extend `entryPointPatterns` per framework and add more `src/domain/*.ts` dictionaries.
   Before the 5th–6th dictionary, harden `detectDomain` (IDF keyword weights + runner-up
   margin → `null` on near-ties) — see "Scaling detection past ~5–6 domains" above.
