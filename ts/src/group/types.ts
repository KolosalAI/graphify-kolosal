// Logical grouping model (Plan 08): the 3-level tree category → feature → module.
export interface GroupFlag {
  kind: "misplaced" | "hidden-coupling" | "split-domain";
  detail: string;
}

export interface ModuleRef {
  id: string; // module node id ("module:<relPath>")
  relPath: string;
  godNodes: string[]; // this module's own god-node labels
}

export interface Feature {
  id: string;
  label: string;
  description: string;
  // Plan 11 sources added: token (Pillar A), token+entry (A∩B), dictionary (Pillar C).
  source: "folder" | "name" | "community" | "embedding" | "token" | "token+entry" | "dictionary" | "folder-fallback";
  modules: ModuleRef[];
  godNodes: string[]; // feature-local top god nodes
  cohesion: number; // internal / (internal+external) edge weight
  structuralAgreement: number; // overlap with community detection [0,1]
  flags: GroupFlag[];
  labeledBy: "llm" | "fallback";
  // ── Plan 11 (feature detection) ─────────────────────────────────────────────
  domainToken?: string; // "cart", "product search"
  aliases?: string[]; // surface variants / route names merged in
  canonical?: string; // Pillar C dictionary label, when matched
  domain?: string; // detected domain: "ecommerce" | "banking" | …
  confidence?: "high" | "medium" | "low";
  evidence?: { crossLayerSpread: number; entryPoints?: string[] };
}

export interface Category {
  id: string;
  label: string;
  description: string;
  features: Feature[];
  moduleCount: number;
  godNodes: string[];
  labeledBy: "llm" | "fallback";
}

export interface Grouping {
  categories: Category[];
  meta: {
    moduleCount: number;
    categoryCount: number;
    featureCount: number;
    llm: boolean;
    model?: string;
    flags: number;
    uncategorized: number;
    // ── Plan 11 ─────────────────────────────────────────────────────────────
    domain?: string; // detected business domain (Pillar C), if any
    domainMatched?: string[]; // canonical features matched in the code
    expectedNotFound?: string[]; // dictionary features with no code (advisory)
    excludedTests?: number; // test modules kept out of feature detection
    featureMode?: "vocabulary" | "folder"; // which cut produced the features
  };
}

export interface GroupingOptions {
  /** LLM labeling (Stage 5) — not wired in Stages 1–4; fallback labels used. */
  llm?: boolean;
  /** Plan 11 feature-detection knobs (role affixes, layer dirs, minFeatureSize…). */
  feature?: import("./vocabulary.js").FeatureConfig;
  /** Force the folder-L1 cut (Plan 08) instead of vocabulary clustering (Plan 11). */
  featureMode?: "vocabulary" | "folder";
}

// ── slim summary (category-feature.json): no module lists ────────────────────
export interface FeatureSummary {
  id: string;
  label: string;
  description: string;
  moduleCount: number;
  godNodes: string[];
  flags: GroupFlag["kind"][];
}
export interface CategorySummary {
  id: string;
  label: string;
  description: string;
  moduleCount: number;
  godNodes: string[];
  features: FeatureSummary[];
}
export interface CategoryFeatureSummary {
  categories: CategorySummary[];
  meta: { categoryCount: number; featureCount: number; moduleCount: number; llm: boolean; model?: string };
}
