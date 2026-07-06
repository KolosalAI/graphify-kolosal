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
  // ── Plan 12 (common vs business) ────────────────────────────────────────────
  tier?: Tier; // "business" | "common"
  commonSignals?: string[]; // why it was tiered common (audit)
  uses?: string[]; // forward cross-link → common featureIds (post-ubiquity-trim)
  usedBy?: string[]; // inverse cross-link ← business featureIds (on common features)
  dataModels?: string[]; // data-model featureIds this feature operates on
  // ── Plan 13 (interconnection splitting) ─────────────────────────────────────
  ops?: FeatureOperation[]; // business-meaningful operations within this feature (verb+noun)
}

export type Tier = "business" | "common";

// Plan 13: an operation = an interconnected core inside a business feature (Update Product, …).
export interface FeatureOperation {
  key: string;
  label: string; // "Update Product"
  verb: string;
  entry: string; // Plan 14: entry symbol node id (root of this operation's call graph)
  symbols: string[]; // member symbol qualifiedNames
  modules: string[]; // hosting relPaths
}
// Plan 13: a page/route that wires operations together — references them, does not own them.
export interface Consumer {
  id: string;
  label: string;
  kind: "page" | "component" | "route" | "module";
  modules: string[];
  references: string[]; // operation keys
}

export interface Category {
  id: string;
  label: string;
  description: string;
  features: Feature[];
  moduleCount: number;
  godNodes: string[];
  labeledBy: "llm" | "fallback";
  tier?: Tier; // Plan 12
}

// Plan 12: the output nests two tiers, each its own category tree.
export interface Grouping {
  business: { categories: Category[] };
  common: { categories: Category[] };
  meta: {
    schemaVersion: number; // Plan 12: 2 = nested business/common
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
    // ── Plan 12 ─────────────────────────────────────────────────────────────
    businessFeatureCount?: number;
    commonFeatureCount?: number;
    ubiquityThreshold?: number; // effective distinct-feature fan-in cutoff
    ubiquitous?: string[]; // trimmed ubiquitous symbols/modules (logger, env, …)
    // ── Plan 13 ─────────────────────────────────────────────────────────────
    operationCount?: number; // total business operations surfaced across features
    consumers?: Consumer[]; // pages/routes wiring operations together
  };
}

export interface GroupingOptions {
  /** LLM labeling (Stage 5) — not wired in Stages 1–4; fallback labels used. */
  llm?: boolean;
  /** Plan 11 feature-detection knobs (role affixes, layer dirs, minFeatureSize…). */
  feature?: import("./vocabulary.js").FeatureConfig;
  /** Force the folder-L1 cut (Plan 08) instead of vocabulary clustering (Plan 11). */
  featureMode?: "vocabulary" | "folder";
  /** Plan 12 ubiquity cutoff: fraction (0,1) → ×featureCount, or absolute int; floor 5. */
  ubiquityThreshold?: number;
}

// ── slim summary (category-feature.json): no module lists ────────────────────
export interface FeatureSummary {
  id: string;
  label: string;
  description: string;
  moduleCount: number;
  godNodes: string[];
  flags: GroupFlag["kind"][];
  tier?: Tier; // Plan 12
  uses?: string[]; // Plan 12 cross-links
  usedBy?: string[];
  dataModels?: string[];
  ops?: string[]; // Plan 13 operation labels
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
  business: { categories: CategorySummary[] };
  common: { categories: CategorySummary[] };
  meta: {
    schemaVersion: number;
    categoryCount: number;
    featureCount: number;
    businessFeatureCount: number;
    commonFeatureCount: number;
    moduleCount: number;
    llm: boolean;
    model?: string;
    domain?: string;
    ubiquitous?: string[];
  };
}
