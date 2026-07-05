// Domain dictionary registry + enforcement helpers (Plan 11, Pillar C). Pure & language-
// agnostic. Used AFTER the Pillar A + Pillar B fuse to (1) detect the corpus's domain and
// (2) canonicalize discovered feature tokens to that domain's vocabulary.
import type { DomainDictionary, DomainFeature } from "./types.js";
import { ECOMMERCE } from "./ecommerce.js";
import { BANKING } from "./banking.js";
import { TRAVEL } from "./travel.js";

export type { DomainDictionary, DomainFeature } from "./types.js";
export { ECOMMERCE } from "./ecommerce.js";
export { BANKING } from "./banking.js";
export { TRAVEL } from "./travel.js";

export const DOMAINS: DomainDictionary[] = [ECOMMERCE, BANKING, TRAVEL];

/** Lowercase + strip to alphanumerics so `Check-In`, `check_in`, `CheckIn` all match. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// keyword → feature index, per dictionary (built once).
const INDEX = new Map<string, Map<string, DomainFeature>>();
for (const dict of DOMAINS) {
  const m = new Map<string, DomainFeature>();
  for (const f of dict.features) for (const k of f.keywords) m.set(normalizeToken(k), f);
  INDEX.set(dict.domain, m);
}

export interface DomainMatch {
  domain: string;
  score: number; // number of distinct dictionary keywords found in the corpus tokens
  matched: string[]; // the matched canonical feature names
}

/**
 * Detect the most likely domain by overlap of corpus tokens with each dictionary.
 * Returns null if nothing matches (don't force a domain on an unrelated codebase).
 */
export function detectDomain(tokens: Iterable<string>, minScore = 3): DomainMatch | null {
  const norm = new Set<string>();
  for (const t of tokens) norm.add(normalizeToken(t));
  let best: DomainMatch | null = null;
  for (const dict of DOMAINS) {
    const idx = INDEX.get(dict.domain)!;
    const hitFeatures = new Set<string>();
    for (const k of idx.keys()) if (norm.has(k)) hitFeatures.add(idx.get(k)!.canonical);
    const score = hitFeatures.size;
    if (!best || score > best.score) best = { domain: dict.domain, score, matched: [...hitFeatures].sort() };
  }
  return best && best.score >= minScore ? best : null;
}

/** Canonicalize a discovered feature token to a dictionary feature, or null if unknown. */
export function canonicalFeature(token: string, domain: string): DomainFeature | null {
  return INDEX.get(domain)?.get(normalizeToken(token)) ?? null;
}

/** All canonical categories a domain defines (for grouping). */
export function domainCategories(domain: string): string[] {
  const dict = DOMAINS.find((d) => d.domain === domain);
  if (!dict) return [];
  return [...new Set(dict.features.map((f) => f.category))];
}
