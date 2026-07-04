# Plan 03 — Parse Filtered Tree → AST (TypeScript port)

**Goal:** Take the parseable-only directory produced by [Plan 02](02-zip-extract-and-filter.md)
and parse every kept file through tree-sitter (via [Plan 01](01-grammars.md)'s loader),
yielding a tree-sitter AST per file. This is the bridge between ingest and extraction.

## Position in the pipeline

```
 .zip ─▶ [02] extract/filter ─▶ PreparedTree ─▶ [03] parse ─▶ ParsedFile (AST) ─▶ [04] extract nodes/edges
```

Plan 03 does **not** interpret the AST — it only produces it. Turning nodes/edges into
the graph (the `LanguageConfig` walk from `extract.py`) is Plan 04.

## Input / output

**In:** the `PreparedTree` from Plan 02 — specifically `rootDir` + `report.kept`, where
each `FileRecord` already carries a resolved grammar `key` and `parseableNow === true`.
Reusing that `key` means **no re-detection** — the parse stage never re-sniffs a file.

**Out:** a `ParsedFile` per kept file:

```ts
export interface ParsedFile {
  relPath: string;      // forward-slash, relative to rootDir
  key: string;          // grammar key (from Plan 02)
  source: string;       // UTF-8 source (retained for byte-slicing by Plan 04)
  tree: Tree;           // live web-tree-sitter Tree — MUST be tree.delete()'d after use
  rootType: string;     // e.g. "module", "program", "translation_unit"
  hasError: boolean;    // tree-sitter is error-tolerant; this flags partial parses
  errorCount: number;   // ERROR + MISSING nodes
  bytes: number;
  status: "ok" | "error" | "skipped-too-large" | "timeout";
}
```

> **The AST *is* the live `Tree`.** Plan 04 walks it directly; the hot path keeps the
> native tree and frees it promptly. For anything that needs the AST *after* it's freed —
> inspection, persistence, snapshot tests — `serializeAst()` captures a plain-JSON node
> tree while the tree is alive (see "AST serialization" below).

---

## Reuse from Plan 01, and the caching strategy

The loader already caches `Language` objects. Two rules make bulk parsing efficient and
leak-free:

1. **One `Language` per grammar (cached):** `loadLanguage(key)` in the loader already
   memoizes. Good as-is.
2. **One `Parser` per grammar, reused across files — not `getParser()` per file.**
   `getParser()` allocates a fresh `Parser` each call; for a repo of thousands of files
   that's thousands of wasm allocations. Instead keep a `Map<key, Parser>` in the parse
   session and call `parser.parse(source)` repeatedly. A `Parser` is reusable and
   stateless between `parse` calls (pass no `oldTree`).

Batch/iterate files grouped by `key` so the active language changes rarely (minor win),
but correctness doesn't depend on order since each parser is bound to its own language.

---

## Memory management (the part that bites)

web-tree-sitter allocates `Tree` and `Parser` objects in the **wasm heap**; GC does not
reclaim them. Leaks here OOM a large repo. Rules:

- Every `Tree` must be `tree.delete()`d exactly once, after its consumer is done.
- Every `Parser` in the session `Map` must be `parser.delete()`d at session end.
- Therefore **prefer a visitor/streaming API** over returning an array of live trees:
  parse one file → hand the `ParsedFile` to a callback → delete the tree → next file.
  This bounds live wasm memory to ~one tree at a time.

```ts
// streaming: bounded memory, tree freed right after the visitor returns
export async function parseEach(
  prepared: PreparedTree,
  visit: (pf: ParsedFile) => void | Promise<void>,
  opts?: ParseOptions,
): Promise<ParseSummary>;
```

A convenience `parseAll()` that returns `ParsedFile[]` with **serialized** ASTs (trees
already deleted) is fine; returning an array of **live** trees is not — it invites leaks.

---

## Parsing algorithm

For each `FileRecord` in `report.kept`:

1. Read `rootDir/relPath` as a UTF-8 string.
2. **Size guard:** if `bytes > limits.maxParseBytes`, emit `status: "skipped-too-large"`
   and continue (don't feed a pathological file to the parser).
3. Get/create the parser for `record.key` (session `Map`). Optionally
   `parser.setTimeoutMicros(limits.parseTimeoutMs * 1000)` so a runaway parse aborts →
   `parse()` returns `null` → emit `status: "timeout"`.
4. `const tree = parser.parse(source)`. If `null` → `timeout`.
5. Compute `hasError = tree.rootNode.hasError` and `errorCount` (walk for `ERROR` /
   `isMissing` nodes). A partial tree is still useful — keep it, just flag it.
6. Emit the `ParsedFile`; after the visitor returns, `tree.delete()`.

`report.unparseable` (pending-grammar files) is **not** parsed — by construction Plan 02
already removed them from disk, so they never reach this stage.

---

## AST serialization (for inspection & persistence)

A first-class output, not just a debug aid: the live wasm `Tree` is freed right after the
visitor runs, so anything we want to **look at later** — verify what got parsed, diff
across grammar versions, snapshot-test, or hand the AST to another process — must be
captured as a plain, serializable form while the tree is still alive. `serializeAst`
produces that JSON node tree.

```ts
export interface AstNode {
  type: string;                     // node type, e.g. "function_definition"
  named: boolean;                   // named vs anonymous (punctuation/keywords)
  field?: string;                   // field name in parent, when any (e.g. "name", "body")
  startIndex: number; endIndex: number;   // UTF-16 offsets (see caveat below)
  start: [row: number, col: number];
  end: [row: number, col: number];
  text?: string;                    // leaf text by default; internal nodes only if includeText
  missing?: boolean;                // true for inserted MISSING nodes
  children: AstNode[];
}

export interface SerializeOptions {
  includeText?: boolean;   // include text on internal nodes too (default: leaves only)
  namedOnly?: boolean;     // drop anonymous nodes for a compact, readable tree
  maxDepth?: number;       // stop descending past this depth
}

export function serializeAst(root: Node, opts?: SerializeOptions): AstNode;
```

Capture the **field name** during traversal (via `TreeCursor.currentFieldName`) — it's
what makes a serialized AST useful for inspection (you can see the `name`/`body`/`function`
roles the Python `LanguageConfig` keys off), and it's only available mid-walk.

### Persisting for later inspection

`parseEach` takes an optional `emitAst` sink so serialized trees are written as the parse
runs (while each tree is live), independent of the live-tree consumer:

```ts
export interface ParseOptions {
  limits?: ParseLimits;
  /** When set, serialize each file's AST and write it for later inspection. */
  emitAst?: {
    dir: string;                       // output root; mirrors rootDir's structure
    format?: "json" | "sexp";          // JSON node tree (default) or S-expression
    serialize?: SerializeOptions;      // passed through to serializeAst
  };
}
```

Layout of the dump (mirrors the source tree so a file's AST is easy to find):

```
<emitAst.dir>/
  proj/main.py.ast.json          # serializeAst(root) as JSON  (format: "json")
  proj/app.ts.ast.json
  index.json                     # manifest: relPath → { key, rootType, hasError, errorCount, astFile }
```

- **`format: "json"`** — the `AstNode` tree above; machine-diffable, snapshot-friendly.
- **`format: "sexp"`** — tree-sitter's built-in `rootNode.toString()` (LISP-style
  S-expression); compact and human-readable, ideal for eyeballing and golden tests.
- **`index.json`** — one entry per parsed file so inspection tooling can enumerate results
  without walking the dump; carries the parse status/error counts alongside the AST path.

This keeps the runtime hot path lean (no retained live trees) while giving a durable,
inspectable record of every AST the pipeline produced. Errored files still get an AST dump
(partial tree) plus their `errorCount` in `index.json`, so you can inspect *why* a parse
went wrong after the fact.

---

## Encoding caveat (carry-over from Plan 01)

web-tree-sitter node `startIndex`/`endIndex` are **UTF-16 code-unit offsets**, while the
Python graphify uses UTF-8 byte offsets. Keep the retained `source` as the same JS string
the parser saw, and have Plan 04 slice with those UTF-16 offsets — do **not** mix in
`Buffer` byte offsets. Flag files containing non-BMP characters if exact byte parity with
the Python output is ever required.

## Concurrency

One web-tree-sitter instance is single-threaded wasm; parsing is synchronous CPU work.
So parse **sequentially** within a session — `parallel` map over files buys nothing and
risks interleaving parser state. If throughput matters later, shard files across N worker
threads, each with its own wasm instance + parser cache (out of scope here).

---

## Proposed layout & API

```
ts/src/parse/
  limits.ts     # maxParseBytes, parseTimeoutMs (or fold into util/limits.ts)
  parser.ts     # ParseSession: per-key Parser cache, parseFile, parseEach, dispose
  ast.ts        # serializeAst, errorCount, cursor walk helpers
  index.ts      # public surface
```

```ts
// src/parse/parser.ts  (ParseOptions incl. emitAst is defined in "AST serialization" above)
export interface ParseSummary { ok: number; error: number; skipped: number; timeout: number }

export async function parseEach(
  prepared: PreparedTree,
  visit: (pf: ParsedFile) => void | Promise<void>,
  opts?: ParseOptions,
): Promise<ParseSummary>;

/** Parse a single kept file by its record. */
export async function parseFile(
  rootDir: string,
  record: FileRecord,
  session: ParseSession,
  opts?: ParseOptions,
): Promise<ParsedFile>;
```

A `ParseSession` owns the `Map<key, Parser>` and a `dispose()` that deletes every parser.
`parseEach` creates one internally and disposes it in a `finally`.

---

## Verification (definition of done)

1. **End-to-end from a fixture zip:** reuse the Plan 02 ingest fixture → `parseEach`
   yields one `ParsedFile` per kept file with the expected `rootType`
   (python→`module`, ts→`program`, c→`translation_unit`, …) and `hasError === false`.
2. **`.tsx` uses the tsx grammar** end-to-end (JSX parses without error).
3. **Error tolerance:** a deliberately broken source (e.g. `def f(:`) yields
   `status: "error"`, `hasError === true`, `errorCount > 0` — and does **not** throw.
4. **Size guard / timeout:** an oversized file → `skipped-too-large`; a pathological file
   under a tiny timeout → `timeout`. Neither crashes the session.
5. **No wasm leak:** after `parseEach` over the fixture, every tree was deleted and the
   session disposed (assert via a counter / that re-running many iterations is flat in
   memory).
6. **Serialization:** `serializeAst` produces a stable JSON snapshot for a small file
   (field names present, e.g. the `name` child of a `function_definition`); `maxDepth`
   and `namedOnly` prune as specified; `toString()` S-expression matches a golden fixture.
7. **Persistence / inspection:** with `emitAst.dir` set, `parseEach` writes one
   `<relPath>.ast.json` per kept file plus an `index.json` whose entries match the
   `ParsedFile` metadata (key, rootType, hasError, errorCount); an errored file still gets
   a (partial) AST dump and a nonzero `errorCount` in the index. `format: "sexp"` writes
   the S-expression variant.

## Risks / open questions

- **Freeing trees vs. Plan 04 needing them:** the extractor must finish walking a tree
  **before** `parseEach` deletes it. The visitor contract enforces this (delete happens
  after `visit` resolves) — but if Plan 04 wants to retain data, it must copy out (node
  types, ranges, text) inside the visitor, not stash the live node.
- **Timeout API drift:** `setTimeoutMicros` naming/behavior varies across web-tree-sitter
  versions (0.25 also exposes a progress-callback parse option). Pin the mechanism to the
  installed version and cover it with a test.
- **`node.text` vs retained source:** `node.text` works but recomputes from stored input;
  for hot extraction, slice the retained `source` by `startIndex`/`endIndex` instead.
- **Huge single files** (minified survivors, generated code): the size guard is the
  backstop; tune `maxParseBytes` against real inputs.

## Phasing

1. `parser.ts` — `ParseSession` + `parseFile` + `parseEach`, size/timeout guards, memory
   discipline (per-key parser cache, tree delete after visit).
2. `ast.ts` — cursor-based `errorCount` + `serializeAst` (with field names, `namedOnly`,
   `maxDepth`) + `toSExpression`.
3. `emitAst` sink in `parseEach` — write `<relPath>.ast.json` / `.sexp` + `index.json`
   under `emitAst.dir` for later inspection, serializing while each tree is live.
4. Smoke test: parse the Plan 02 fixture end-to-end; assert root types, error tolerance,
   guards, no-leak, and that the AST dump + `index.json` are written and well-formed.
5. Hand `ParsedFile` (live tree + source) to **Plan 04** (LanguageConfig walk →
   nodes/edges), which consumes it inside the visitor.

---

## Execution status (implemented in `ts/src/parse/` + `ts/main.js`)

| File | Role |
|---|---|
| `src/parse/ast.ts` | `serializeAst` (field names, `namedOnly`, `maxDepth`), `toSExpression`, `errorCount` |
| `src/parse/parser.ts` | `ParseSession` (per-key `Parser` cache), `parseFile`, `parseEach` w/ `emitAst`, `safeParse` |
| `src/parse/index.ts` | public surface |
| `src/parse/smoke.ts` | end-to-end fixture test (`npm run parse-smoke`) |
| `main.js` | CLI: single file → AST, or `.zip` → full Plan 02+03 pipeline |

- **Verified — `npm run parse-smoke` → 18/18 pass:** per-language root types
  (python→`module`, ts/tsx→`program`, go→`source_file`); ingest-filtered `logo.png`
  never parsed; `broken.py` → `status:"error"`, `hasError`, `errorCount>0` **without
  throwing**; `summary` tallies (ok=4, error=1); visitor sees live trees; `emitAst`
  writes per-file `.ast.json` + `index.json`; `serializeAst` captures the `name` field of
  a `function_definition`. `npm run typecheck` clean.
- **`main.js` verified end-to-end:**
  - single file: `npx tsx main.js sample.py` → `root: module`, writes `sample.py.ast.json`,
    prints a named-only depth-2 preview.
  - zip: `npx tsx main.js demo.zip` → `ingest: kept 5, unparseable 1, removed 2,
    skipped 1` then `parse: ok 4, error 1`, ASTs + `index.json` under `graphify-ast-out/`.
- **Run via tsx** (project ships TS sources): `npm run main -- <file>` or
  `npx tsx main.js <file>`. Plain `node main.js` won't work (imports `.ts`).

### Deviations

- **Timeout:** web-tree-sitter 0.25's `setTimeoutMicros` has a broken BigInt binding, so
  `safeParse` uses the `progressCallback` cancel form with a plain-parse fallback. The
  `maxParseBytes` size guard remains the primary backstop; the `timeout` status is wired
  but only fires if the runtime honors `progressCallback`.
- `graphify-ast-out/` and `*.ast.json` added to `.gitignore`.
