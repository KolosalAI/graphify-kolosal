# Plan 02 — Zip Ingest, Extract & Code-File Filter (TypeScript port)

**Goal:** Turn an uploaded `.zip` into a clean temp directory containing **only files a
grammar can parse**, ready for the extractor. Extract safely to a temp dir, classify
every file as code / not-code, delete the not-code, and hand back the pruned root plus a
report of what was kept and dropped.

This is the stage *before* parsing — it feeds the loader from
[Plan 01](01-grammars.md). "Parseable" is defined by that plan's grammar set, not
guessed independently.

## Position in the pipeline

```
 .zip  ──▶  [02] extract → classify → prune  ──▶  clean temp dir  ──▶  [03] parse (per-file getParserForFile)
```

## Inputs / outputs

- **In:** path to a `.zip` (later: a stream / buffer).
- **Out:**
  - `rootDir`: temp directory with only kept files (non-code removed, empty dirs pruned).
  - `report`: `{ kept: FileRecord[], removed: FileRecord[], skipped: FileRecord[] }`
    where each record carries `relPath`, `bytes`, `ext`, `reason`, and (for kept) the
    resolved grammar `key`.
  - `dispose()`: removes the temp dir. Caller owns lifecycle.

---

## Source of truth: reuse the grammar manifest

The keep decision keys off [`grammar/manifest.ts`](../grammar/manifest.ts) — do **not**
maintain a second extension list:

- `BY_EXTENSION` → does any grammar claim this extension?
- entry `status` → `"tier-a"` (has wasm, parseable now) vs `"pending"` (known code, no
  wasm yet).

A file is **code** iff its extension resolves in `BY_EXTENSION`. That splits cleanly:

| Manifest result | Meaning | Action (default) |
|---|---|---|
| resolves, `status: "tier-a"` | parseable now | **keep on disk** |
| resolves, `status: "pending"` | code, grammar not built yet | **remove from disk**, record in `unparseable` |
| no resolve, but sniffed as code | extensionless code (Dockerfile, shebang) | **keep** if allowlisted (maps to a built grammar) |
| no resolve | not code | **remove**, record in `removed` |

> **Invariant: the leftover tree contains only parseable files.** Pending-grammar code
> (lua, julia, …) is real source, so it is *tracked* in the `unparseable` report bucket
> rather than silently dropped — but it is removed from disk so the parse stage never
> sees a file it can't handle. Set `keepUnparseable: true` to retain those files on disk
> (e.g. to re-ingest once the grammar lands).

---

## Pipeline stages

### 1. Safe extraction → temp dir

Extract to `mkdtemp()` under the OS temp dir (or the session scratchpad). **Security is
the hard part of this stage** — a zip is untrusted input:

- **Zip-slip / path traversal:** reject or clamp any entry whose resolved path escapes
  the temp root (`../`, absolute paths, drive letters). Resolve then verify
  `resolvedPath.startsWith(rootReal + sep)`.
- **Symlinks:** do **not** materialize symlink entries — skip them (a symlink can point
  outside the root and later reads would follow it). Record as `skipped`.
- **Zip bombs / resource limits:** cap total uncompressed bytes, per-file bytes, entry
  count, and compression ratio. Abort with a clear error past the ceiling.
- **Nested archives:** by default do **not** recurse into inner `.zip`/`.tar` — record
  and drop them (revisit as an option).
- Normalize to a stable path form; reject NUL bytes / illegal chars.

Prefer a maintained streaming unzip lib (e.g. `yauzl`, `unzipper`, or `fflate`) over
hand-rolling. Wrap it so the security checks above run per entry *before* write.

### 2. Classification

For each extracted file, in order:

1. **Hard-exclude directories** (never descend / always drop): `.git`, `.svn`, `.hg`,
   `node_modules`, `vendor`, `.venv`/`venv`, `dist`, `build`, `out`, `target`,
   `.next`, `.gradle`, `__pycache__`, `.idea`, `.vscode`, coverage dirs.
2. **Binary sniff:** read the first ~8 KB; if it contains NUL bytes or fails UTF-8/UTF-16
   decoding, treat as binary → remove (covers images, media, archives, compiled objects
   without trusting the extension).
3. **Extension lookup** in `BY_EXTENSION` → keep per the table above.
4. **Extensionless code:** match known basenames (`Dockerfile`, `Makefile`, `Rakefile`,
   `Gemfile`, `Jenkinsfile`, `CMakeLists.txt`) and shebang lines (`#!/usr/bin/env
   python`, `#!/bin/bash`, …) → keep, mapping to the right grammar key when one exists.
5. **Everything else → remove.**

### 3. Prune

Delete every `remove`/binary file, then remove now-empty directories bottom-up. Leave a
tree of only kept files. Emit the report.

---

## Not-code categories removed (reference)

| Category | Examples |
|---|---|
| Images / media | png, jpg, gif, svg, mp4, mov, mp3, wav, pdf |
| Archives / binaries | zip, tar, gz, exe, dll, so, dylib, o, a, class, wasm, bin |
| Lockfiles / vendored | package-lock.json, yarn.lock, uv.lock, Cargo.lock, poetry.lock |
| Minified / generated | `*.min.js`, `*.min.css`, `*.map`, `*.bundle.js`, generated protobufs |
| Data / docs (parse-stage) | csv, xlsx, parquet, md, txt, rst — *see note* |
| VCS / IDE / CI metadata | `.gitignore`, `.DS_Store`, `.editorconfig`, IDE dirs |
| Fonts / certs / keys | ttf, woff, pem, key, crt |

> **Note on docs/data:** full graphify *does* ingest docs (md/pdf/…) for the knowledge
> graph. This plan is the **parse** stage, so it removes them by default. Make the doc
> set a configurable passthrough (`keepDocs: boolean`) so a later doc-ingest stage can
> opt in without changing the code filter.

---

## Proposed layout & API

```
ts/src/ingest/
  extract.ts     # safe unzip -> temp dir (security checks)
  classify.ts    # FileRecord + code/not-code decision (reuses manifest)
  prune.ts       # delete not-code, remove empty dirs
  prepare.ts     # orchestrates: zip -> { rootDir, report, dispose }
  limits.ts      # size/count/ratio ceilings (one place to tune)
```

```ts
// src/ingest/prepare.ts
export interface PreparedTree {
  rootDir: string;
  report: { kept: FileRecord[]; removed: FileRecord[]; skipped: FileRecord[] };
  dispose(): Promise<void>;
}
export async function prepareZip(zipPath: string, opts?: PrepareOptions): Promise<PreparedTree>;
```

Classification is a pure function over `(relPath, headBytes)` so it's unit-testable
without touching disk:

```ts
// src/ingest/classify.ts
export type Decision = { action: "keep" | "remove" | "skip"; reason: string; key?: string };
export function classify(relPath: string, head: Buffer): Decision;
```

---

## Verification (definition of done)

1. **Round-trip:** a fixture zip with mixed content (source in 3+ languages + images +
   node_modules + a lockfile) yields a temp dir containing exactly the source files;
   report lists every removal with a reason.
2. **Security fixtures pass:**
   - zip-slip entry (`../../evil`) is rejected, nothing written outside root.
   - symlink entry is skipped, not materialized.
   - oversized / high-ratio zip aborts at the limit, temp dir cleaned up.
3. **Extension edge cases:** `.tsx` kept (routes to tsx later), `Dockerfile` kept via
   basename, `app.min.js` removed, a `pending`-language file (e.g. `.jl`) kept.
4. **Binary sniff:** a `.txt`-renamed PNG is removed despite the text extension.
5. `dispose()` fully removes the temp dir; no leak on error paths.

## Risks / open questions

- **Extension collisions across grammars:** `.m` = Objective-C *or* MATLAB, `.h` = C /
  C++ / Objective-C, `.pl` = Perl / Prolog. Manifest currently maps `.m`→objc, `.h`→c.
  Keep-decision only needs "is it code" (collision is fine here); precise grammar
  selection is the parse stage's problem — but flag ambiguous extensions in the report.
- **Huge repos:** stream + cap concurrency; don't read whole files (head bytes only for
  the sniff).
- **Encoding:** UTF-16/BOM source shouldn't be misclassified as binary — check for BOM
  before the NUL-byte heuristic.
- **Temp location:** honor the session scratchpad dir when set, else OS temp; never CWD.

## Phasing

1. `limits.ts` + `extract.ts` with all security checks + security fixtures.
2. `classify.ts` (pure, manifest-backed) + unit tests for the decision table.
3. `prune.ts` + `prepare.ts` orchestration + round-trip fixture test.
4. Wire `keepDocs` passthrough and ambiguous-extension reporting.
5. Hand off `rootDir` to Plan 03 (parse: walk files → `getParserForFile`).

---

## Execution status (implemented in `ts/util/`)

Built under `ts/src/util/` (all runtime code consolidated under `src/`):

| File | Role |
|---|---|
| `src/util/limits.ts` | `Limits` ceilings + `ZipLimitError` |
| `src/util/classify.ts` | pure `classify(relPath, head)` + `EXCLUDED_DIRS`, `looksBinary`, shebang/basename maps |
| `src/util/extract.ts` | `extractZip` — safe unzip with all security checks |
| `src/util/prune.ts` | `removeFile`, `pruneEmptyDirs` |
| `src/util/prepare.ts` | `prepareZip(zipPath) → { rootDir, report, dispose }` + `parseableFiles()` |
| `src/util/smoke.ts` | fixture-based smoke test (`npm run ingest-smoke`) |

- **Unzip library:** chose **`fflate`** (pure-JS, zero native deps). Its `unzipSync`
  `filter` runs per entry with the uncompressed size available, so per-file / total /
  ratio / entry-count limits are enforced **before decompression**. fflate never
  creates symlinks (writes data only), closing the symlink-escape vector by construction.
- **Parseable-only invariant enforced.** The report has four buckets — `kept`
  (parseable, on disk), `unparseable` (code, no grammar yet, removed from disk),
  `removed` (not code), `skipped` (extraction rejects). Default keeps only parseable
  files on disk; `keepUnparseable: true` opts pending-grammar source back in.
- **Verified — `npm run ingest-smoke` → 23/23 assertions pass:**
  - keeps real source across languages incl. `.tsx`, extensionless `Dockerfile`, and a
    `#!/usr/bin/env python` shebang script;
  - a **pending-grammar** `.jl` file goes to `unparseable` and is **off disk**;
  - removes png, md, csv, `*.min.js`, `package-lock.json`;
  - **zip-slip** (`../evil.py`) rejected as `unsafe-path`, nothing written outside root;
  - **binary sniff** removes a PNG renamed `secret.txt` despite the `.txt` extension;
  - `node_modules/` skipped before extraction (`excluded-dir`);
  - **every file remaining on disk is in `kept` and `parseableNow` — asserted by walking
    the tree** (no stragglers);
  - `dispose()` removes the temp tree.
- `tsc --noEmit` clean (tsconfig `include` extended to `util`).

### Deviations / notes

- **Docs removed by default** as planned (`.md`, `.csv` dropped). The `keepDocs`
  passthrough (Phase 4) is **not yet wired** — currently docs always drop. Add when the
  doc-ingest stage lands.
- Added `*.d.ts` to the remove list (type-only, no runtime code to parse).
- **Whole zip is read into memory** (`readFileSync` + `unzipSync`). Fine for typical
  uploads; for very large archives switch to fflate's streaming `Unzip`. Limits still
  cap damage since they're checked per entry pre-decompression.
- Ambiguous-extension reporting (`.m`, `.h`) — Phase 4, not yet added.

### Remaining (Phases 4–5)

- `keepDocs` option + ambiguous-extension flags in the report.
- Streaming extraction for very large zips.
- Hand off `rootDir` to **Plan 03** (walk kept files → `getParserForFile` → parse).
