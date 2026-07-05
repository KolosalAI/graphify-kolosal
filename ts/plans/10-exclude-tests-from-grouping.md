# Plan 10 — Exclude Test Suites & Integration Tests from the Grouping Output

**Goal:** `category-feature.json` (and `grouping.json`) should represent **product/app code
only** — no unit tests, integration/e2e suites, smoke tests, fixtures, or mocks showing up
as categories or features. Today a test file that survives ingest is parsed → graphed →
grouped, so the output sprawls with `__tests__` / `test` / `e2e` / `spec` categories and
features that aren't part of the real architecture.

## Current state

`buildGrouping(graph, files)` partitions **every** module relPath in the call graph. Test
files (`*.test.ts`, `__tests__/`, `e2e/`, `test_*.py`, `*_test.go`, `*.smoke.ts`, …) are
classified as code by ingest ([Plan 02](02-zip-extract-and-filter.md)), so they become
modules → features → categories. `category-feature.json` is a pure projection of that tree,
so the tests leak straight through.

Plan 07 already has `testFilePatterns` / `testFuncPatterns` in `config.ts` (used only to
mark dead-code *roots*). This plan promotes a shared test predicate to a first-class filter.

## Decision — filter in `buildGrouping`, share one predicate

- **Primary fix (this plan):** drop test modules **in `buildGrouping`** before partitioning.
  Because `category-feature.json` is a projection, filtering the tree cleans both files at
  once. Default **on** (`dropTests: true`).
- **One source of truth:** a shared `isTestPath(relPath)` used here — and reusable at ingest
  (Plan 02) and dead-code (Plan 07) — so detection never drifts.
- **Transparent, not silent:** record how many were removed in `meta.excludedTests` (and
  optionally the paths behind a verbose flag). Removing code from an output without saying so
  reads as "we found nothing there."

### Optional deeper cut (flagged, not default)

Dropping tests only at grouping means the **call graph / god nodes / dead code still include
them**. For a fully test-free analysis, apply the same `isTestPath` at ingest (Plan 02
`classify`) behind a `--no-tests` flag. Out of scope for the default, but the shared
predicate makes it a one-line reuse. Call this out so users know grouping-only filtering is
cosmetic to that one artifact.

## Test detection (`isTestPath`) — segment/anchor matched, not substring

Match **whole path segments** and **anchored filename patterns** so `attestation.ts`,
`latest.ts`, or a domain folder `contest/` are never caught.

- **Directory segments:** `__tests__`, `tests`, `test`, `e2e`, `integration`, `spec`,
  `__mocks__`, `mocks`, `fixtures`, `testdata`, `cypress`, `.storybook`.
- **Filenames:** `*.test.*`, `*.spec.*`, `*.smoke.*`, `*_test.go`, `test_*.py`, `*_spec.rb`,
  `conftest.py`, `*.stories.*`, and config shims (`jest.config.*`, `vitest.config.*`,
  `playwright.config.*`, `cypress.config.*`).

Seed from Plan 07's `testFilePatterns` and extend; keep it a single exported list so all
languages/conventions live in one place and users can override.

## Behavior

- `dropTests` (default `true`): test modules are removed from the module set fed to
  partitioning. Any feature/category that becomes empty is **collapsed/removed** (reuse the
  existing collapse logic), so no empty "Tests" husk remains.
- `meta.excludedTests: number` added; `main.js` prints `excluded N test modules`.
- **Alternative mode** (`testGroup: "drop" | "bucket"`, default `drop`): `bucket` routes all
  test modules into one hidden group counted in meta but **omitted from
  `category-feature.json`** (kept in full `grouping.json` for reference). `drop` removes them
  everywhere. Default `drop` for the cleanest summary.

## API

```ts
export interface GroupingOptions {
  // …existing…
  dropTests?: boolean;              // default true
  testGroup?: "drop" | "bucket";    // default "drop"
  testFilter?: (relPath: string) => boolean; // override the default predicate
}
export function isTestPath(relPath: string): boolean; // shared, exported
```

`buildGrouping` filters `files` through `!isTestPath` (or the custom `testFilter`) up front;
everything downstream (god-node lookup, community detection, projection) then sees only
product modules.

## Verification (definition of done)

1. **Cleaned output:** a repo with `src/**` plus `tests/`, `__tests__/`, `*.test.ts`,
   `e2e/`, `test_*.py`, `*_test.go` → `category-feature.json` has **no** `Test`/`Tests`/
   `e2e`/`integration`/`__tests__`/`spec` category or feature; `meta.excludedTests` equals
   the number of test modules.
2. **No false positives:** `attestation.ts`, `latest.ts`, `src/contest/` are **not**
   excluded (segment/anchor matching).
3. **Empties collapse:** a category that was *only* tests disappears entirely (no empty node).
4. **Escape hatch:** `dropTests: false` reproduces today's output exactly.
5. **Shared predicate:** `isTestPath` is imported by grouping (and available to ingest/
   dead-code) — no second copy of the pattern list.
6. **Determinism preserved:** same inputs → identical `category-feature.json`.

## Risks / open questions

- **Convention coverage:** Go `*_test.go`, Python `test_*.py`/`conftest.py`, Ruby
  `*_spec.rb`, JS `*.test`/`*.spec`/`__tests__` — cover the common set, keep the list
  extensible via `testFilter`.
- **Product code under a `test/` folder** (rare, e.g. a testing *library*): give a config
  override / `dropTests:false`; document that the folder heuristic can misfire there.
- **Grouping-only vs whole-pipeline:** if only grouping filters tests, god nodes / dead code
  still count them. State this clearly; recommend the ingest-level `--no-tests` for full
  exclusion.
- **Fixtures that are real assets** vs test fixtures: `fixtures/` is treated as test-only;
  if a project ships product fixtures under that name, override.

## Phasing

1. Add `isTestPath` + the shared pattern list (extend Plan 07's `testFilePatterns`); export it.
2. `buildGrouping`: `dropTests` filter (default on) + collapse empties + `meta.excludedTests`.
3. `main.js`: print `excluded N test modules`; verify `category-feature.json` is clean.
4. (Optional) `testGroup: "bucket"` mode; and reuse `isTestPath` at ingest behind `--no-tests`
   for whole-pipeline exclusion.

---

## Execution status — DONE (drop mode)

- **`src/group/tests.ts`** — exported `isTestPath(relPath)`: segment-matched test dirs
  (`__tests__`, `tests`, `test`, `e2e`, `integration`, `spec`, `__mocks__`, `mocks`,
  `fixtures`, `testdata`, `cypress`, `.storybook`) + anchored filename patterns
  (`*.test.*`, `*.spec.*`, `*.smoke.*`, `*.stories.*`, `*_test.go`, `test_*.py`,
  `conftest.py`, `*_spec.rb`, runner configs).
- **`buildGrouping`** filters test modules before partitioning (`dropTests` default `true`,
  `testFilter` override); `Grouping.meta.excludedTests` + summary meta added.
- **`main.js`** prints `(excluded N test modules)`; `category-feature.json` auto-clean.
- **Verified — `npm run group-smoke` → 32/32:** segment/anchor matching (no false positives
  on `attestation.ts`, `latest.ts`, `contest/`), test modules removed from the tree, no
  `Test/Tests/E2e` category, `latest.py` retained, `excludedTests` counted, `dropTests:false`
  restores all. Demo zip (7 files, 3 tests) → categories `Auth, Billing`, `excludedTests: 3`,
  no test/e2e strings in output (only the benign `latest` module + the `excludedTests` field).
  `typecheck` clean; `dist` rebuilt (`tests.js` emitted).

### Deviations
- **`testGroup: "bucket"` mode** and the **ingest-level `--no-tests`** deeper cut are **not**
  implemented (deferred, as planned) — grouping-only filtering is cosmetic to
  `grouping.json`/`category-feature.json`; call graph / god nodes / dead code still include
  test files.
- **API realignment (incidental):** `llm.ts` had been reverted to the batch `labelGrouping`,
  but `index.ts`/`main.js` still referenced the Plan-09 `createLabeler`. Realigned both to
  `labelGrouping` (+ updated `group/smoke.ts`) so the project builds again.
