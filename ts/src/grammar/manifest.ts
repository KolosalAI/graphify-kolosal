// Grammar manifest — the TS analogue of the Python `LanguageConfig.ts_module` +
// `ts_language_fn` indirection in python/graphify/extract.py (~line 3049).
//
// Each entry maps a language key to its committed .wasm artifact and the file
// extensions that select it. The loader (src/grammar/loader.ts) resolves an
// extension or key -> wasm, exactly as the Python side does `import_module(ts_module)`.
//
// `status` records acquisition tier from Plan 01:
//   "tier-a"  prebuilt wasm present in grammar/wasm/ (via tree-sitter-wasms)
//   "pending" core language still needing a Tier B/C build (no wasm yet)

export type GrammarStatus = "tier-a" | "pending";

export interface GrammarEntry {
  /** stable language key */
  key: string;
  /** wasm filename under grammar/wasm/ (undefined until built) */
  wasm?: string;
  /** file extensions (lowercase, no dot) that select this grammar */
  extensions: string[];
  status: GrammarStatus;
  /** Python pkg this ports, for traceability */
  pyModule: string;
}

// Tier A — prebuilt wasm available and synced into grammar/wasm/.
const TIER_A: GrammarEntry[] = [
  { key: "python", wasm: "tree-sitter-python.wasm", extensions: ["py", "pyi"], status: "tier-a", pyModule: "tree_sitter_python" },
  { key: "javascript", wasm: "tree-sitter-javascript.wasm", extensions: ["js", "jsx", "mjs", "cjs"], status: "tier-a", pyModule: "tree_sitter_javascript" },
  // tree-sitter-typescript ships two languages; .tsx MUST use the tsx wasm (JSX-aware),
  // mirroring _TS_CONFIG / _TSX_CONFIG in extract.py (~line 2645/2670).
  { key: "typescript", wasm: "tree-sitter-typescript.wasm", extensions: ["ts", "mts", "cts"], status: "tier-a", pyModule: "tree_sitter_typescript" },
  { key: "tsx", wasm: "tree-sitter-tsx.wasm", extensions: ["tsx"], status: "tier-a", pyModule: "tree_sitter_typescript" },
  { key: "go", wasm: "tree-sitter-go.wasm", extensions: ["go"], status: "tier-a", pyModule: "tree_sitter_go" },
  { key: "rust", wasm: "tree-sitter-rust.wasm", extensions: ["rs"], status: "tier-a", pyModule: "tree_sitter_rust" },
  { key: "java", wasm: "tree-sitter-java.wasm", extensions: ["java"], status: "tier-a", pyModule: "tree_sitter_java" },
  { key: "c", wasm: "tree-sitter-c.wasm", extensions: ["c", "h"], status: "tier-a", pyModule: "tree_sitter_c" },
  { key: "cpp", wasm: "tree-sitter-cpp.wasm", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"], status: "tier-a", pyModule: "tree_sitter_cpp" },
  { key: "ruby", wasm: "tree-sitter-ruby.wasm", extensions: ["rb"], status: "tier-a", pyModule: "tree_sitter_ruby" },
  { key: "csharp", wasm: "tree-sitter-c-sharp.wasm", extensions: ["cs"], status: "tier-a", pyModule: "tree_sitter_c_sharp" },
  { key: "kotlin", wasm: "tree-sitter-kotlin.wasm", extensions: ["kt", "kts"], status: "tier-a", pyModule: "tree_sitter_kotlin" },
  { key: "scala", wasm: "tree-sitter-scala.wasm", extensions: ["scala", "sc"], status: "tier-a", pyModule: "tree_sitter_scala" },
  { key: "php", wasm: "tree-sitter-php.wasm", extensions: ["php"], status: "tier-a", pyModule: "tree_sitter_php" },
  { key: "swift", wasm: "tree-sitter-swift.wasm", extensions: ["swift"], status: "tier-a", pyModule: "tree_sitter_swift" },
  { key: "zig", wasm: "tree-sitter-zig.wasm", extensions: ["zig"], status: "tier-a", pyModule: "tree_sitter_zig" },
  { key: "elixir", wasm: "tree-sitter-elixir.wasm", extensions: ["ex", "exs"], status: "tier-a", pyModule: "tree_sitter_elixir" },
  { key: "objc", wasm: "tree-sitter-objc.wasm", extensions: ["m", "mm"], status: "tier-a", pyModule: "tree_sitter_objc" },
  { key: "bash", wasm: "tree-sitter-bash.wasm", extensions: ["sh", "bash"], status: "tier-a", pyModule: "tree_sitter_bash" },
  { key: "json", wasm: "tree-sitter-json.wasm", extensions: ["json"], status: "tier-a", pyModule: "tree_sitter_json" },
  // Enterprise extras beyond the Python set — prebuilt wasm already in the bundle.
  // No pyModule (not ported from Python); "-" marks a TS-only addition.
  { key: "dart", wasm: "tree-sitter-dart.wasm", extensions: ["dart"], status: "tier-a", pyModule: "-" },
  { key: "solidity", wasm: "tree-sitter-solidity.wasm", extensions: ["sol"], status: "tier-a", pyModule: "-" },
  { key: "ocaml", wasm: "tree-sitter-ocaml.wasm", extensions: ["ml", "mli"], status: "tier-a", pyModule: "-" },
  // ql (CodeQL): the tree-sitter-wasms prebuilt crashes the runtime ("memory access
  // out of bounds"). Excluded — needs a rebuilt/known-good wasm before it can ship.
];

// Pending — core Python grammars with no prebuilt wasm in tree-sitter-wasms.
// Build from source (Tier B/C) in a follow-up, then set wasm + status "tier-a".
const PENDING: GrammarEntry[] = [
  // lua: the tree-sitter-wasms prebuilt is stale (fails on calls/function defs).
  // Build from the pinned tree-sitter-lua (>=0.2,<0.6) instead — Tier B.
  { key: "lua", extensions: ["lua"], status: "pending", pyModule: "tree_sitter_lua" },
  { key: "groovy", extensions: ["groovy", "gradle"], status: "pending", pyModule: "tree_sitter_groovy" },
  { key: "powershell", extensions: ["ps1", "psm1"], status: "pending", pyModule: "tree_sitter_powershell" },
  { key: "verilog", extensions: ["v", "sv", "svh"], status: "pending", pyModule: "tree_sitter_verilog" },
  { key: "fortran", extensions: ["f90", "f95", "f03", "f", "for"], status: "pending", pyModule: "tree_sitter_fortran" },
  { key: "julia", extensions: ["jl"], status: "pending", pyModule: "tree_sitter_julia" },
];

export const GRAMMARS: GrammarEntry[] = [...TIER_A, ...PENDING];

export const BY_KEY: Map<string, GrammarEntry> = new Map(GRAMMARS.map((g) => [g.key, g]));

export const BY_EXTENSION: Map<string, GrammarEntry> = new Map(
  GRAMMARS.flatMap((g) => g.extensions.map((ext) => [ext, g] as const)),
);

/** Languages that currently have a loadable wasm. */
export const READY: GrammarEntry[] = GRAMMARS.filter((g) => g.status === "tier-a" && g.wasm);
