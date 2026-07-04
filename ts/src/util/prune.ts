// Pruning helpers (Plan 02, stage 3): delete not-code files and collapse the
// now-empty directories they leave behind.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Remove a single file (best-effort; missing file is not an error). */
export function removeFile(absPath: string): void {
  rmSync(absPath, { force: true });
}

/**
 * Recursively remove directories that are (or become) empty, bottom-up.
 * Returns the number of directories removed.
 */
export function pruneEmptyDirs(root: string): number {
  let removed = 0;
  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    let empty = true;
    for (const name of entries) {
      const child = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const childEmptied = walk(child);
        if (!childEmptied) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== root) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
      return true;
    }
    return empty;
  };
  walk(root);
  return removed;
}
