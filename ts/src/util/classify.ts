// Code / not-code classifier (Plan 02, stage 2).
//
// Pure function over (relPath, head bytes) so the decision table is unit-testable
// without disk. "Is this parseable code?" is answered by the grammar manifest
// (grammar/manifest.ts) — the single source of truth from Plan 01 — never a second
// hand-maintained extension list.

import { BY_EXTENSION } from "../grammar/manifest.js";

export type Action = "keep" | "remove" | "skip";

export interface Decision {
  action: Action;
  reason: string;
  /** grammar key when kept as code */
  key?: string;
  /** true when a built wasm exists now; false for known-code "pending" grammars */
  parseableNow?: boolean;
}

// Directory segments we never descend into or keep — VCS, deps, build output, IDE.
export const EXCLUDED_DIRS = new Set<string>([
  ".git", ".svn", ".hg", ".bzr",
  "node_modules", "bower_components", "vendor",
  ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "dist", "build", "out", "target", "bin", "obj",
  ".next", ".nuxt", ".svelte-kit", ".gradle", ".m2",
  ".idea", ".vscode", ".vs",
  "coverage", ".nyc_output", ".terraform",
]);

// Extensionless (or oddly-named) files that ARE code, mapped to a grammar key.
const CODE_BASENAMES = new Map<string, string>([
  ["Dockerfile", "bash"], // no dockerfile grammar yet; treated as shell-ish, kept
  ["Makefile", "bash"],
  ["GNUmakefile", "bash"],
  ["Rakefile", "ruby"],
  ["Gemfile", "ruby"],
  ["Guardfile", "ruby"],
  ["Brewfile", "ruby"],
  ["Vagrantfile", "ruby"],
  ["Jenkinsfile", "groovy"],
  ["CMakeLists.txt", "c"],
]);

// Files/patterns to remove even though their extension resolves to a grammar
// (generated, minified, lock, map). Checked before the extension keep.
const REMOVE_BASENAMES = new Set<string>([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "uv.lock", "poetry.lock", "Pipfile.lock", "Cargo.lock", "Gemfile.lock",
  "composer.lock", "go.sum", "flake.lock",
]);

const REMOVE_PATTERNS: RegExp[] = [
  /\.min\.(js|mjs|cjs|css)$/i,
  /\.bundle\.(js|mjs|cjs)$/i,
  /\.map$/i, // source maps
  /\.d\.ts$/i, // TS type-only declaration files: no runtime code to parse
];

function basename(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? relPath : relPath.slice(i + 1);
}

function extNoDot(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return ""; // no dot, or dotfile like ".gitignore"
  return name.slice(i + 1).toLowerCase();
}

/** UTF-16 BOM means text, not binary — check before the NUL-byte heuristic. */
function hasUtf16Bom(head: Buffer): boolean {
  return head.length >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
}

/** Standard robust binary heuristic: a NUL byte in the head → binary. */
export function looksBinary(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (hasUtf16Bom(head)) return false;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

/** Map a `#!` shebang interpreter to a grammar key, if recognizable. */
function shebangKey(head: Buffer): string | undefined {
  if (head.length < 2 || head[0] !== 0x23 || head[1] !== 0x21) return undefined; // "#!"
  const firstLine = head.toString("utf8", 0, Math.min(head.length, 256)).split("\n", 1)[0];
  if (/\b(bash|sh|zsh|dash)\b/.test(firstLine)) return "bash";
  if (/\bpython[0-9.]*\b/.test(firstLine)) return "python";
  if (/\bruby\b/.test(firstLine)) return "ruby";
  if (/\bnode\b/.test(firstLine)) return "javascript";
  if (/\bphp\b/.test(firstLine)) return "php";
  return undefined;
}

/**
 * Decide keep/remove/skip for one file.
 * @param relPath forward-slash relative path inside the extracted tree
 * @param head    first N bytes of the file (limits.sniffBytes) for content sniffing
 */
export function classify(relPath: string, head: Buffer): Decision {
  const segments = relPath.split("/");

  // 1. Excluded directory anywhere in the path.
  for (const seg of segments.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(seg)) return { action: "remove", reason: `excluded-dir:${seg}` };
  }

  const base = basename(relPath);

  // 2. Binary content → remove (catches a PNG renamed .txt, compiled objects, media).
  if (looksBinary(head)) return { action: "remove", reason: "binary" };

  // 3. Explicit removals that would otherwise pass the extension keep.
  if (REMOVE_BASENAMES.has(base)) return { action: "remove", reason: "lockfile" };
  for (const re of REMOVE_PATTERNS) {
    if (re.test(base)) return { action: "remove", reason: "generated-or-minified" };
  }

  // 4. Known code basenames (extensionless / special).
  const byBase = CODE_BASENAMES.get(base);
  if (byBase) return { action: "keep", reason: "code-basename", key: byBase, parseableNow: true };

  // 5. Extension resolves to a grammar → code.
  const ext = extNoDot(base);
  if (ext) {
    const entry = BY_EXTENSION.get(ext);
    if (entry) {
      return {
        action: "keep",
        reason: entry.status === "tier-a" ? "code" : "code-pending-grammar",
        key: entry.key,
        parseableNow: entry.status === "tier-a" && !!entry.wasm,
      };
    }
  }

  // 6. No extension match — try a shebang.
  const sh = shebangKey(head);
  if (sh) return { action: "keep", reason: "shebang", key: sh, parseableNow: true };

  // 7. Everything else is not code we parse.
  return { action: "remove", reason: "not-code" };
}
