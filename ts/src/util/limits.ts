// Resource ceilings for untrusted-zip extraction (Plan 02, stage 1).
// One place to tune the zip-bomb / DoS guards. Enforced in extract.ts *before*
// each entry is decompressed.

export interface Limits {
  /** Max uncompressed bytes for a single entry. */
  maxFileBytes: number;
  /** Max total uncompressed bytes across the whole archive. */
  maxTotalBytes: number;
  /** Max number of entries (files + dirs). */
  maxEntries: number;
  /** Max uncompressed/compressed ratio for a single entry (classic bomb signal). */
  maxCompressionRatio: number;
  /** Bytes read from the head of each file for the binary/shebang sniff. */
  sniffBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 25 * 1024 * 1024, // 25 MB
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxEntries: 200_000,
  maxCompressionRatio: 200,
  sniffBytes: 8192,
};

/** Thrown when an archive exceeds a hard ceiling; extraction aborts and cleans up. */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}
