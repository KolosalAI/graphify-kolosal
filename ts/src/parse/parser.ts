// Parse driver (Plan 03) — take Plan 02's PreparedTree and parse each kept file
// through tree-sitter into an AST. Reuses one Parser per grammar (session cache)
// and frees every wasm Tree right after the visitor runs. Optionally serializes
// each AST to disk (emitAst) for later inspection.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Parser } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import { init, loadLanguage } from "../grammar/loader.js";
import type { FileRecord, PreparedTree } from "../util/prepare.js";
import { errorCount, serializeAst, toSExpression, type SerializeOptions } from "./ast.js";

export interface ParsedFile {
  relPath: string;
  key: string;
  source: string;
  /** live wasm tree — valid only until parseEach frees it after the visitor */
  tree?: Tree;
  rootType: string;
  hasError: boolean;
  errorCount: number;
  bytes: number;
  status: "ok" | "error" | "skipped-too-large" | "timeout";
}

export interface ParseLimits {
  maxParseBytes: number;
  parseTimeoutMs: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxParseBytes: 8 * 1024 * 1024, // 8 MB — huge files (generated/minified survivors) skip
  parseTimeoutMs: 5000,
};

export interface EmitAstOptions {
  dir: string;
  format?: "json" | "sexp";
  serialize?: SerializeOptions;
}

export interface ParseOptions {
  limits?: Partial<ParseLimits>;
  emitAst?: EmitAstOptions;
}

export interface ParseSummary {
  ok: number;
  error: number;
  skipped: number;
  timeout: number;
}

/** Owns one reusable Parser per grammar key. dispose() frees them from the wasm heap. */
export class ParseSession {
  private parsers = new Map<string, Parser>();

  async getParser(key: string): Promise<Parser> {
    let p = this.parsers.get(key);
    if (!p) {
      await init();
      const language = await loadLanguage(key);
      p = new Parser();
      p.setLanguage(language);
      this.parsers.set(key, p);
    }
    return p;
  }

  dispose(): void {
    for (const p of this.parsers.values()) p.delete();
    this.parsers.clear();
  }
}

// Timeout handling drifted across web-tree-sitter versions (0.25's setTimeoutMicros has
// a broken BigInt binding). Prefer the 0.25 progressCallback form — return true to cancel
// past the deadline, which makes parse() return null — and fall back to a plain parse if
// this runtime doesn't accept the options argument.
function safeParse(parser: Parser, source: string, timeoutMs: number): Tree | null {
  const start = Date.now();
  const cancel = () => Date.now() - start > timeoutMs;
  try {
    return (parser as any).parse(source, null, { progressCallback: cancel });
  } catch {
    /* options form unsupported — fall back */
  }
  try {
    return parser.parse(source);
  } catch {
    return null;
  }
}

/** Parse one kept file. The returned tree (if any) is the caller's to delete. */
export async function parseFile(
  rootDir: string,
  record: FileRecord,
  session: ParseSession,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
): Promise<ParsedFile> {
  const key = record.key!;
  const abs = join(rootDir, record.relPath);
  const bytes = record.bytes ?? statSync(abs).size;
  const base = { relPath: record.relPath, key, bytes };

  if (bytes > limits.maxParseBytes) {
    return { ...base, source: "", rootType: "", hasError: false, errorCount: 0, status: "skipped-too-large" };
  }

  const source = readFileSync(abs, "utf8");
  const parser = await session.getParser(key);

  const tree = safeParse(parser, source, limits.parseTimeoutMs);
  if (!tree) {
    return { ...base, source, rootType: "", hasError: false, errorCount: 0, status: "timeout" };
  }

  const root = tree.rootNode;
  const hasError = !!(root as any).hasError;
  return {
    ...base,
    source,
    tree,
    rootType: root.type,
    hasError,
    errorCount: hasError ? errorCount(root) : 0,
    status: hasError ? "error" : "ok",
  };
}

function astFileName(relPath: string, format: "json" | "sexp"): string {
  return format === "sexp" ? `${relPath}.ast.sexp` : `${relPath}.ast.json`;
}

function writeAstDump(emit: EmitAstOptions, pf: ParsedFile): string {
  const format = emit.format ?? "json";
  const rel = astFileName(pf.relPath, format);
  const out = join(emit.dir, rel);
  mkdirSync(dirname(out), { recursive: true });
  const root = pf.tree!.rootNode;
  const body =
    format === "sexp" ? toSExpression(root) : JSON.stringify(serializeAst(root, emit.serialize), null, 2);
  writeFileSync(out, body);
  return rel;
}

/**
 * Parse every kept file, hand each ParsedFile to `visit`, then free its tree.
 * Bounds live wasm memory to ~one tree at a time. If emitAst is set, each AST is
 * serialized to disk (while its tree is alive) plus an index.json manifest.
 */
export async function parseEach(
  prepared: PreparedTree,
  visit: (pf: ParsedFile) => void | Promise<void>,
  opts: ParseOptions = {},
): Promise<ParseSummary> {
  const limits = { ...DEFAULT_PARSE_LIMITS, ...(opts.limits ?? {}) };
  const session = new ParseSession();
  const summary: ParseSummary = { ok: 0, error: 0, skipped: 0, timeout: 0 };
  const index: Array<Record<string, unknown>> = [];

  try {
    for (const record of prepared.report.kept) {
      const pf = await parseFile(prepared.rootDir, record, session, limits);

      // Serialize BEFORE the tree is freed.
      if (opts.emitAst && pf.tree) {
        const astFile = writeAstDump(opts.emitAst, pf);
        index.push({
          relPath: pf.relPath,
          key: pf.key,
          rootType: pf.rootType,
          hasError: pf.hasError,
          errorCount: pf.errorCount,
          status: pf.status,
          astFile,
        });
      }

      await visit(pf);
      if (pf.tree) pf.tree.delete();

      if (pf.status === "ok") summary.ok++;
      else if (pf.status === "error") summary.error++;
      else if (pf.status === "timeout") summary.timeout++;
      else summary.skipped++;
    }

    if (opts.emitAst) {
      mkdirSync(opts.emitAst.dir, { recursive: true });
      writeFileSync(join(opts.emitAst.dir, "index.json"), JSON.stringify(index, null, 2));
    }
  } finally {
    session.dispose();
  }

  return summary;
}
