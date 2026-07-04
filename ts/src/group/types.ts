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
  source: "folder" | "name" | "community" | "embedding";
  modules: ModuleRef[];
  godNodes: string[]; // feature-local top god nodes
  cohesion: number; // internal / (internal+external) edge weight
  structuralAgreement: number; // overlap with community detection [0,1]
  flags: GroupFlag[];
  labeledBy: "llm" | "fallback";
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
  };
}

export interface GroupingOptions {
  /** LLM labeling (Stage 5) — not wired in Stages 1–4; fallback labels used. */
  llm?: boolean;
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
