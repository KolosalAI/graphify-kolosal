# Plan 01 — Grammar Acquisition & Loading (TypeScript port)

**Goal:** Stand up every tree-sitter grammar the Python `graphify` uses, wired into a
single generic loader for the TS port — before any extractor logic is written. This
plan covers *only* getting the grammars parsable in Node/TS. Extractor porting (the
`LanguageConfig`-driven walk) is a later plan.

## Source of truth

The Python grammar set is declared in [`python/pyproject.toml`](../../python/pyproject.toml)
(lines 17–42 core, 72–77 optional) and loaded generically in
[`python/graphify/extract.py`](../../python/graphify/extract.py) around line 3049:

```python
mod      = importlib.import_module(config.ts_module)   # e.g. "tree_sitter_typescript"
language = Language(getattr(mod, config.ts_language_fn)())  # e.g. "language_typescript"
parser   = Parser(language)
tree     = parser.parse(source_bytes)
```

The TS port must reproduce this "one config → one language function" indirection so the
same `LanguageConfig` table drives both runtimes.

---

## Decision: WASM (`web-tree-sitter`), not native bindings

| | Native (`tree-sitter` + N addons) | **WASM (`web-tree-sitter`) — chosen** |
|---|---|---|
| Build | node-gyp / C++ per grammar (~27 native builds) | none — prebuilt `.wasm` blobs |
| Platform matrix | per-OS/arch prebuilds or compile on install | single artifact, runs everywhere + browser |
| Version skew | core ABI must match every addon | one runtime, per-grammar ABI checked at load |
| Distribution | heavy postinstall | ship `.wasm` files alongside the package |

Porting ~27 grammars over native addons means a fragile cross-platform build matrix.
WASM sidesteps it entirely and matches how VS Code / most JS code-intel tools ship.
**Loader target: `web-tree-sitter`.** Native remains a fallback only if a specific
grammar has no usable `.wasm`.

---

## Full grammar inventory (Python → npm/wasm)

Core set (installed by default in Python — must all work in TS):

| # | Python pkg (pyproject) | Language fn(s) used | npm package | WASM source |
|---|---|---|---|---|
| 1 | `tree-sitter` (core) | — | `web-tree-sitter` | runtime, not a grammar |
| 2 | `tree-sitter-python` | `language` | `tree-sitter-python` | npm prebuilt / `@vscode/tree-sitter-wasm` |
| 3 | `tree-sitter-javascript` | `language` | `tree-sitter-javascript` | npm prebuilt / vscode-wasm |
| 4 | `tree-sitter-typescript` | `language_typescript`, `language_tsx` | `tree-sitter-typescript` | exports **two** wasm: `.ts` + `.tsx` |
| 5 | `tree-sitter-go` | `language` | `tree-sitter-go` | npm / vscode-wasm |
| 6 | `tree-sitter-rust` | `language` | `tree-sitter-rust` | npm / vscode-wasm |
| 7 | `tree-sitter-java` | `language` | `tree-sitter-java` | npm / vscode-wasm |
| 8 | `tree-sitter-groovy` | `language` | `tree-sitter-groovy` | build from grammar repo |
| 9 | `tree-sitter-c` | `language` | `tree-sitter-c` | npm / vscode-wasm |
| 10 | `tree-sitter-cpp` | `language` | `tree-sitter-cpp` | npm / vscode-wasm |
| 11 | `tree-sitter-ruby` | `language` | `tree-sitter-ruby` | npm / vscode-wasm |
| 12 | `tree-sitter-c-sharp` | `language` | `tree-sitter-c-sharp` | npm / vscode-wasm |
| 13 | `tree-sitter-kotlin` | `language` | `tree-sitter-kotlin` (fwcd) | build from grammar repo |
| 14 | `tree-sitter-scala` | `language` | `tree-sitter-scala` | npm / build |
| 15 | `tree-sitter-php` | `language_php` / `language` | `tree-sitter-php` | exports `php` + `php_only` |
| 16 | `tree-sitter-swift` | `language` | `tree-sitter-swift` (alex-pinkus) | build from grammar repo |
| 17 | `tree-sitter-lua` | `language` | `tree-sitter-lua` | npm / build |
| 18 | `tree-sitter-zig` | `language` | `tree-sitter-zig` | build from grammar repo |
| 19 | `tree-sitter-powershell` | `language` | `tree-sitter-powershell` (airbus-cert) | build from grammar repo |
| 20 | `tree-sitter-elixir` | `language` | `tree-sitter-elixir` | npm / build |
| 21 | `tree-sitter-objc` | `language` | `tree-sitter-objc` | build from grammar repo |
| 22 | `tree-sitter-julia` | `language` | `tree-sitter-julia` | npm / build |
| 23 | `tree-sitter-verilog` | `language` | `tree-sitter-verilog` | build from grammar repo |
| 24 | `tree-sitter-fortran` | `language` | `tree-sitter-fortran` | build from grammar repo |
| 25 | `tree-sitter-bash` | `language` | `tree-sitter-bash` | npm / vscode-wasm |
| 26 | `tree-sitter-json` | `language` | `tree-sitter-json` | npm / vscode-wasm |

Optional set (Python extras — port behind an opt-in flag, don't block core):

| # | Python extra | npm package | Notes |
|---|---|---|---|
| 27 | `sql` → `tree-sitter-sql` | `@derekstride/tree-sitter-sql` | multiple forks — pin one |
| 28 | `terraform` → `tree-sitter-hcl` | `tree-sitter-hcl` | HCL/Terraform |
| 29 | `dm` → `tree-sitter-dm` | `tree-sitter-dm` | BYOND DreamMaker — rare, Windows-only wheel in Py; low priority |

> Note the two multi-language grammars that already have special handling in Python and
> **must** carry over: `tree-sitter-typescript` (`.ts` vs `.tsx`, see `_TS_CONFIG` /
> `_TSX_CONFIG` in `extract.py` ~line 2645/2670) and `tree-sitter-php` (`language_php`
> fallback to `language`, `extract.py` ~line 3053).

---

## Dependencies to load in

Concrete packages the port must install. Runtime is intentionally tiny — only
`web-tree-sitter`. Everything else is dev/build tooling to *produce* the committed
`.wasm` files; it is not shipped.

### Runtime (`dependencies`)

```jsonc
{
  "dependencies": {
    "web-tree-sitter": "^0.25.0"   // the WASM tree-sitter runtime (Parser + Language)
  }
}
```

### Build toolchain (`devDependencies`)

```jsonc
{
  "devDependencies": {
    "tree-sitter-cli": "^0.25.0",  // `tree-sitter build --wasm` for Tier B/C
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```
`tree-sitter build --wasm` also needs the Emscripten toolchain (`emcc`) available in
CI/dev — install via `emsdk` or Docker `emscripten/emsdk`. Document this in
`grammar/build/README`.

### Grammar packages — Tier A / B (npm, pin to Python floors)

Install these as `devDependencies` and copy each package's shipped `.wasm` (Tier A) or
run `tree-sitter build --wasm` against it (Tier B) into `grammar/wasm/`. Version ranges
mirror the `pyproject.toml` floors/ceilings so parsed node types match the ported logic
— resolve exact latest-compatible at install time.

```jsonc
{
  "devDependencies": {
    "tree-sitter-python":     "^0.23.0",
    "tree-sitter-javascript": "^0.23.0",
    "tree-sitter-typescript": "^0.23.0",   // ships typescript.wasm + tsx.wasm
    "tree-sitter-go":         "^0.23.0",
    "tree-sitter-rust":       "^0.23.0",
    "tree-sitter-java":       "^0.23.0",
    "tree-sitter-c":          "^0.23.0",
    "tree-sitter-cpp":        "^0.23.0",
    "tree-sitter-ruby":       "^0.23.0",
    "tree-sitter-c-sharp":    "^0.23.0",
    "tree-sitter-php":        "^0.23.0",    // ships php.wasm + php_only.wasm
    "tree-sitter-bash":       "^0.23.0",
    "tree-sitter-json":       "^0.23.0",
    "tree-sitter-scala":      "^0.23.0",    // Tier B — build wasm
    "tree-sitter-lua":        "^0.2.0",     // Tier B
    "tree-sitter-elixir":     "^0.3.0",     // Tier B
    "tree-sitter-julia":      "^0.23.0"     // Tier B
  }
}
```

### Grammar packages — Tier C (vendored repos, no reliable npm)

Not npm dependencies — pin by git commit in `grammar/build/sources.json` and build wasm
in CI. Repos (align tag/commit to the Python floor in the inventory table):

- `tree-sitter-groovy`, `tree-sitter-kotlin` (fwcd), `tree-sitter-swift` (alex-pinkus),
  `tree-sitter-zig`, `tree-sitter-powershell` (airbus-cert), `tree-sitter-objc`,
  `tree-sitter-verilog`, `tree-sitter-fortran`.

### Optional grammars (behind a flag, don't block core install)

```jsonc
{
  "optionalDependencies": {
    "@derekstride/tree-sitter-sql": "*",   // sql
    "tree-sitter-hcl":              "*"     // terraform
  }
}
// tree-sitter-dm (DreamMaker): Tier C, vendored; lowest priority.
```

> A convenience alternative for most Tier A grammars: `@vscode/tree-sitter-wasm` bundles
> a curated set of prebuilt `.wasm` in one dependency. Evaluate it to shrink the Tier A
> devDependency list — but confirm it carries the exact languages/versions above before
> relying on it (it does **not** cover the Tier C long tail).

---

## Acquisition strategy

Grammars fall into three tiers by how easily we get a `.wasm`:

- **Tier A — prebuilt wasm available** (python, js, ts/tsx, go, rust, java, c, cpp,
  ruby, c-sharp, php, bash, json, and most of `@vscode/tree-sitter-wasm`): take the
  published `.wasm` directly.
- **Tier B — npm grammar, build wasm ourselves** (scala, lua, elixir, julia): install
  the npm package and run `tree-sitter build --wasm` against its grammar, or use
  `web-tree-sitter`'s build tooling in CI.
- **Tier C — grammar repo only, vendor + build** (groovy, kotlin, swift, zig,
  powershell, objc, verilog, fortran, and the optional sql/hcl/dm): clone/pin the
  grammar repo, generate + `--wasm` build in CI, commit the artifact.

All produced `.wasm` files land in a single `ts/grammar/wasm/` directory named
`tree-sitter-<lang>.wasm` (+ `tree-sitter-tsx.wasm`, `tree-sitter-php_only.wasm`).

---

## Proposed layout

```
ts/
  grammar/
    wasm/                       # committed .wasm artifacts, one per language
      tree-sitter-python.wasm
      tree-sitter-typescript.wasm
      tree-sitter-tsx.wasm
      tree-sitter-php.wasm
      ...
    manifest.ts                 # language key -> { wasm path, langFn label, exts }
    build/                      # scripts to (re)build Tier B/C wasm from pinned repos
  src/
    grammar/
      loader.ts                 # web-tree-sitter init + cached Language.load()
      languageConfig.ts         # ports the Python LanguageConfig table (later plan)
```

## Loader design (mirror of the Python indirection)

```ts
// src/grammar/loader.ts
import { Parser, Language } from "web-tree-sitter";

let inited = false;
const cache = new Map<string, Language>();

export async function getParser(langKey: string): Promise<Parser> {
  if (!inited) { await Parser.init(); inited = true; }
  let lang = cache.get(langKey);
  if (!lang) {
    const entry = MANIFEST[langKey];           // { wasm } — replaces ts_module + ts_language_fn
    lang = await Language.load(entry.wasm);     // replaces Language(lang_fn())
    cache.set(langKey, lang);
  }
  const p = new Parser();
  p.setLanguage(lang);                          // replaces Parser(language)
  return p;
}
```

The `MANIFEST` (`grammar/manifest.ts`) is the TS analogue of the Python `LanguageConfig`
`ts_module` + `ts_language_fn` fields — it maps a language key to its `.wasm` and file
extensions. TypeScript/PHP get one entry per emitted language (`typescript`+`tsx`,
`php`+`php_only`).

---

## Version pinning

Reproduce Python's version discipline. The Python code explicitly guards ABI mismatch
(`extract.py` ~line 3060, "tree-sitter version mismatch"). In TS the pin lives in two
places: the `web-tree-sitter` runtime version and each grammar's build commit. Record
both — the source grammar version/commit for every committed `.wasm` — in
`grammar/manifest.ts` so a rebuild is reproducible. Keep grammar versions aligned with
the Python floors/ceilings in `pyproject.toml` where a matching upstream tag exists
(e.g. typescript `>=0.23,<0.25`, kotlin `>=1.0,<2.0`).

---

## Verification (definition of done for this plan)

1. `web-tree-sitter` initializes and every Tier A/B/C `.wasm` in `grammar/wasm/` loads
   without an ABI error.
2. A smoke test parses a minimal snippet per language and asserts
   `tree.rootNode.hasError === false` (or a known-good root type).
3. The two dual-language grammars resolve correctly: `.tsx` uses the tsx wasm, `.php`
   uses `php`/`php_only` as the Python fallback does.
4. Optional grammars (sql/hcl/dm) load only when explicitly requested and their absence
   never fails core init — mirroring Python extras.

## Risks / open questions

- **Tier C build burden:** ~8 grammars need us to generate + wasm-build from source in
  CI. Front-load these; they gate full language parity.
- **Grammar drift vs Python:** node-type names can differ across grammar versions (the
  Python code already works around this for kotlin, `extract.py` ~line 2787). Pin to the
  same upstream versions to keep the ported extractor logic valid.
- **`tree-sitter-objc` / `tree-sitter-dm`:** least-maintained; confirm a buildable
  source exists or defer them to a follow-up.
- **UTF-16 vs UTF-8 offsets:** `web-tree-sitter` node indices are UTF-16 code units, not
  UTF-8 bytes — a downstream concern for the extractor port, flagged here so byte-offset
  assumptions aren't baked into the loader.

## Phasing

1. Scaffold `grammar/wasm/`, `grammar/manifest.ts`, `src/grammar/loader.ts`.
2. Land all Tier A grammars + smoke test (fastest path to a working multi-language parser).
3. Add Tier B (npm + local wasm build).
4. Add Tier C (vendored repos + CI wasm build).
5. Wire optional grammars behind a flag.
6. Hand off to Plan 02 (LanguageConfig / extractor port).

---

## Execution status (Phases 1–2 done)

Implemented and verified in `ts/`:

> **Layout note:** all runtime code + wasm assets were later consolidated under `src/`
> so `src/` is a self-contained runtime unit. Runtime now lives at `src/grammar/`
> (`manifest.ts`, `loader.ts`, `wasm/*.wasm`) and `src/util/`; only build tooling
> (`grammar/build/sync-wasm.mjs`) and plans stay outside `src/`.

- **Scaffold:** `package.json` (runtime dep `web-tree-sitter@0.25`, only shipped dep),
  `tsconfig.json` (`include: ["src"]`), `.gitignore`, dirs `src/grammar/wasm/`,
  `grammar/build/`, `src/util/`.
- **Tier A source:** used **`tree-sitter-wasms`** (a single devDependency bundling ~36
  prebuilt `.wasm`) instead of Emscripten-building each grammar — no toolchain needed
  this phase. `grammar/build/sync-wasm.mjs` copies graphify's subset into
  `src/grammar/wasm/`.
- **20 grammars live & smoke-passing:** python, javascript, typescript, tsx, go, rust,
  java, c, cpp, ruby, csharp, kotlin, scala, php, swift, zig, elixir, objc, bash, json.
  Each parses a minimal snippet with `rootNode.hasError === false`; `.tsx` routes to the
  tsx grammar (not typescript). `npm run smoke` → 20/20. `npm run typecheck` clean.
- **`src/grammar/manifest.ts`** ports the Python `ts_module`/`ts_language_fn` indirection:
  key → wasm + extensions + `status` + originating `pyModule`.
- **`src/grammar/loader.ts`** = the TS analogue of `extract.py`'s parse setup:
  `init()` once, cached `Language.load(bytes)`, `getParser(key)` / `getParserForFile(path)`.

### Deviations from the pre-execution plan

- **lua** was expected Tier A but the `tree-sitter-wasms` prebuilt is **stale** (errors on
  calls/function defs). Reclassified to **Tier B** — build from the pinned
  `tree-sitter-lua` (>=0.2,<0.6). Its stale wasm was removed, not shipped.
- Tier C languages **kotlin, swift, zig, objc** turned out to have good prebuilt wasm in
  `tree-sitter-wasms`, so they landed in Tier A early.

### Enterprise-language additions (beyond the Python set)

Zero-cost adds pulled from the `tree-sitter-wasms` bundle and smoke-passing:
**Dart** (Flutter), **Solidity** (fintech/blockchain), **OCaml** (fintech). Marked
`pyModule: "-"` in the manifest since they aren't ported from Python.

Excluded: **CodeQL (ql)** — the prebuilt wasm crashes the runtime ("memory access out of
bounds"); needs a known-good rebuild before it can ship.

**Tier C enterprise candidates** (real gaps, maintained grammars exist, build-from-source
later): **COBOL** (banking/mainframe), **Apex** (Salesforce), **R** (analytics),
**MATLAB** (engineering), plus Erlang, Clojure, Ada, Perl, GraphQL/Protobuf.

**Explicit non-goals** (weak/no tree-sitter support): Visual Basic / VB.NET / VBA, F#,
Delphi/Pascal, PL/SQL & T-SQL procedural bodies, RPG / mainframe assembler, SAS.

### Remaining (Phases 3–5)

- **Build from source (Tier B/C):** lua, groovy, powershell, verilog, fortran, julia —
  all marked `status: "pending"` in the manifest (no wasm yet; loader throws a clear
  "build it first" error). Needs `tree-sitter-cli` + Emscripten in CI.
- **Optional (flagged):** sql, terraform/hcl, dm.
- **php_only** variant (Python's `language_php` fallback) — only base `php.wasm` shipped
  so far; add the `php_only` wasm when needed for embedded-HTML files.
- Then hand off to Plan 02 (extractor port).
