// Copies the prebuilt tree-sitter .wasm files graphify needs from the
// `tree-sitter-wasms` devDependency into ts/src/src/grammar/wasm/ (committed runtime assets).
//
// This is the Tier A source of Plan 01 — prebuilt wasm, no Emscripten required.
// Tier B/C languages (groovy, powershell, verilog, fortran, julia, sql, hcl, dm)
// are NOT here; they get built from source in a later phase and dropped into the
// same wasm/ dir.
//
// Run: npm run sync-wasm
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "node_modules", "tree-sitter-wasms", "out");
const destDir = join(here, "..", "..", "src", "grammar", "wasm");

// source filename (in tree-sitter-wasms/out) -> dest filename (src/grammar/wasm/)
// dest names use the kebab-case convention shared with the Python pkg names.
const MAP = {
  "tree-sitter-python.wasm": "tree-sitter-python.wasm",
  "tree-sitter-javascript.wasm": "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm": "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm": "tree-sitter-tsx.wasm",
  "tree-sitter-go.wasm": "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm": "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm": "tree-sitter-java.wasm",
  "tree-sitter-c.wasm": "tree-sitter-c.wasm",
  "tree-sitter-cpp.wasm": "tree-sitter-cpp.wasm",
  "tree-sitter-ruby.wasm": "tree-sitter-ruby.wasm",
  "tree-sitter-c_sharp.wasm": "tree-sitter-c-sharp.wasm",
  "tree-sitter-kotlin.wasm": "tree-sitter-kotlin.wasm",
  "tree-sitter-scala.wasm": "tree-sitter-scala.wasm",
  "tree-sitter-php.wasm": "tree-sitter-php.wasm",
  "tree-sitter-swift.wasm": "tree-sitter-swift.wasm",
  // lua intentionally omitted: the tree-sitter-wasms prebuilt is stale (fails on
  // calls/function defs). Build from pinned tree-sitter-lua in the Tier B phase.
  "tree-sitter-zig.wasm": "tree-sitter-zig.wasm",
  "tree-sitter-elixir.wasm": "tree-sitter-elixir.wasm",
  "tree-sitter-objc.wasm": "tree-sitter-objc.wasm",
  "tree-sitter-bash.wasm": "tree-sitter-bash.wasm",
  "tree-sitter-json.wasm": "tree-sitter-json.wasm",
  // Enterprise extras already prebuilt in tree-sitter-wasms (zero-cost adds).
  "tree-sitter-dart.wasm": "tree-sitter-dart.wasm",
  "tree-sitter-solidity.wasm": "tree-sitter-solidity.wasm",
  "tree-sitter-ocaml.wasm": "tree-sitter-ocaml.wasm",
  // ql (CodeQL) omitted: the tree-sitter-wasms prebuilt crashes the runtime
  // ("memory access out of bounds"). Needs a known-good wasm before shipping.
};

mkdirSync(destDir, { recursive: true });

let copied = 0;
const missing = [];
for (const [src, dest] of Object.entries(MAP)) {
  const srcPath = join(srcDir, src);
  if (!existsSync(srcPath)) {
    missing.push(src);
    continue;
  }
  copyFileSync(srcPath, join(destDir, dest));
  copied++;
}

console.log(`synced ${copied} Tier A wasm grammars -> src/grammar/wasm/`);
if (missing.length) {
  console.warn(`WARNING: ${missing.length} not found in tree-sitter-wasms:`, missing.join(", "));
  process.exitCode = 1;
}
