// Zip → clean tree orchestration (Plan 02).
//
//   .zip ──▶ extract (safe) ──▶ classify each file ──▶ prune not-code ──▶ { rootDir, report }
//
// The returned rootDir contains only files a grammar can parse (incl. "pending"
// languages whose wasm isn't built yet). Caller owns lifecycle via dispose().

import { closeSync, mkdtempSync, openSync, readSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { classify, type Action } from "./classify.js";
import { extractZip, type SkippedEntry } from "./extract.js";
import { removeFile, pruneEmptyDirs } from "./prune.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";

export interface FileRecord {
  /** forward-slash path relative to rootDir */
  relPath: string;
  bytes: number;
  reason: string;
  /** grammar key, when kept as code */
  key?: string;
  parseableNow?: boolean;
}

export interface PrepareReport {
  /** code with a built grammar — left on disk, ready to parse */
  kept: FileRecord[];
  /** code whose grammar isn't built yet — removed from disk unless keepUnparseable */
  unparseable: FileRecord[];
  /** not code — removed from disk */
  removed: FileRecord[];
  /** rejected during extraction (security / limits / excluded dirs) */
  skipped: SkippedEntry[];
}

export interface PreparedTree {
  rootDir: string;
  report: PrepareReport;
  dispose(): void;
}

export interface PrepareOptions {
  limits?: Limits;
  /** Directory to create the temp tree under (defaults to OS temp dir). */
  tmpRoot?: string;
  /**
   * Keep code files whose grammar isn't built yet on disk (default false).
   * Default: the leftover tree contains ONLY parseable files. Set true to retain
   * pending-grammar source (e.g. for a re-ingest once the grammar lands).
   */
  keepUnparseable?: boolean;
}

/** Read the first `n` bytes of a file without loading the whole thing. */
function readHead(absPath: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  const fd = openSync(absPath, "r");
  try {
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export function prepareZip(zipPath: string, opts: PrepareOptions = {}): PreparedTree {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const base = opts.tmpRoot ?? tmpdir();
  const rootDir = mkdtempSync(join(base, "graphify-ingest-"));

  const dispose = () => rmSync(rootDir, { recursive: true, force: true });

  try {
    const zipData = readFileSync(zipPath);
    const { written, skipped } = extractZip(zipData, rootDir, limits);

    const kept: FileRecord[] = [];
    const unparseable: FileRecord[] = [];
    const removed: FileRecord[] = [];
    const keepUnparseable = opts.keepUnparseable ?? false;

    for (const relPath of written) {
      const abs = join(rootDir, relPath);
      const bytes = statSync(abs).size;
      const head = readHead(abs, limits.sniffBytes);
      const decision = classify(toPosix(relPath), head);

      const rec: FileRecord = {
        relPath,
        bytes,
        reason: decision.reason,
        key: decision.key,
        parseableNow: decision.parseableNow,
      };

      const action: Action = decision.action;
      if (action !== "keep") {
        // not code — remove from disk.
        removeFile(abs);
        removed.push(rec);
      } else if (decision.parseableNow) {
        // code with a built grammar — the leftover tree we want.
        kept.push(rec);
      } else if (keepUnparseable) {
        // code, no grammar yet — retained on disk by opt-in.
        kept.push(rec);
      } else {
        // code, no grammar yet — removed so the tree stays parseable-only.
        removeFile(abs);
        unparseable.push(rec);
      }
    }

    pruneEmptyDirs(rootDir);

    return { rootDir, report: { kept, unparseable, removed, skipped }, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/**
 * Files on disk that are ready to parse now. By default every kept file qualifies;
 * the filter also holds when keepUnparseable retained pending-grammar files.
 */
export function parseableFiles(report: PrepareReport): FileRecord[] {
  return report.kept.filter((r) => r.parseableNow);
}
