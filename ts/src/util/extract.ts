// Safe zip extraction (Plan 02, stage 1).
//
// Untrusted input: every entry is vetted BEFORE it is decompressed or written.
// - zip-slip / path traversal: entries resolving outside the temp root are rejected.
// - zip bombs / DoS: per-file, total, ratio, and entry-count ceilings (limits.ts).
// - symlinks: fflate never creates symlinks — it only writes file data — so the
//   symlink-escape vector is closed by construction. We note such data as written
//   regular files; the classifier removes them if they aren't code.
// - excluded dirs (node_modules/.git/…): skipped before decompression to avoid
//   materializing large junk trees.
//
// fflate's `unzipSync` filter runs per entry with the uncompressed size available
// from the central directory, so limits are enforced pre-decompression.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { EXCLUDED_DIRS } from "./classify.js";
import { DEFAULT_LIMITS, type Limits, ZipLimitError } from "./limits.js";

export interface SkippedEntry {
  relPath: string;
  reason: string;
}

export interface ExtractResult {
  /** relative (forward-slash) paths written to disk */
  written: string[];
  /** entries rejected during extraction (security / limits / excluded dirs) */
  skipped: SkippedEntry[];
}

/** Reject absolute paths, drive letters, `..` segments, and NUL bytes. */
function isUnsafeName(name: string): boolean {
  if (name.includes("\0")) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(name)) return true; // Windows drive
  return name.split("/").some((seg) => seg === "..");
}

function hasExcludedSegment(name: string): boolean {
  return name.split("/").some((seg) => EXCLUDED_DIRS.has(seg));
}

/**
 * Extract `zipData` into `destDir` (must already exist). Returns what was written and
 * what was skipped (with reasons). Throws ZipLimitError if a hard ceiling is hit.
 */
export function extractZip(
  zipData: Uint8Array,
  destDir: string,
  limits: Limits = DEFAULT_LIMITS,
): ExtractResult {
  const rootReal = resolve(destDir);
  const skipped: SkippedEntry[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  const filter = (file: UnzipFileInfo): boolean => {
    if (++entryCount > limits.maxEntries) {
      throw new ZipLimitError(`entry count exceeds ${limits.maxEntries}`);
    }
    const name = file.name;

    // Directory entries carry no data; let fflate skip them (we mkdir on write).
    if (name.endsWith("/")) return false;

    if (isUnsafeName(name)) {
      skipped.push({ relPath: name, reason: "unsafe-path" });
      return false;
    }
    if (hasExcludedSegment(name)) {
      skipped.push({ relPath: name, reason: "excluded-dir" });
      return false;
    }
    if (file.originalSize > limits.maxFileBytes) {
      skipped.push({ relPath: name, reason: "file-too-large" });
      return false;
    }
    if (file.size > 0 && file.originalSize / file.size > limits.maxCompressionRatio) {
      skipped.push({ relPath: name, reason: "compression-ratio" });
      return false;
    }
    totalBytes += file.originalSize;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipLimitError(`total uncompressed size exceeds ${limits.maxTotalBytes}`);
    }
    return true;
  };

  const files = unzipSync(zipData, { filter });

  const written: string[] = [];
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    // Defense in depth: re-verify the resolved path stays inside the root.
    const abs = resolve(rootReal, name);
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
      skipped.push({ relPath: name, reason: "escapes-root" });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    written.push(name);
  }

  return { written, skipped };
}
