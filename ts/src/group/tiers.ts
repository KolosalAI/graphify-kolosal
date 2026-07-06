// Plan 12 — tier assignment: split Plan 11's flat features into a BUSINESS tier (domain
// capabilities) and a COMMON tier (infrastructure), using layer/name fingerprints (src/common)
// plus lightweight AST/graph structural signals (barrel, types-only). Business features keep only
// their domain modules; their infra modules (routes/repos/db/…) move to the common tier and are
// re-linked via cross-links in buildGrouping. Pure & deterministic.
import type { CallGraph } from "../graph/model.js";
import { projectToModules } from "../graph/project.js";
import type { GodNode } from "../graph/rank.js";
import { classifyCommon, type CommonCategory, COMMON_CATEGORY_ORDER } from "../common/index.js";
import type { VocabFeature, VocabResult } from "./vocabulary.js";
import type { Grouping, Tier } from "./types.js";

export interface TierSlot {
  key: string; // stable unique key (tier|category|label)
  tier: Tier;
  category: string; // business category (Plan 11) or CommonCategory
  label: string;
  modules: string[];
  vf?: VocabFeature; // source vocab feature (business slots carry domain metadata)
  commonCategory?: CommonCategory;
  commonSignals?: string[];
}

export interface TierAssignment {
  slots: TierSlot[];
  moduleCommon: Map<string, CommonCategory>; // relPath → its common category (if common)
}

function titleCase(s: string): string {
  return s
    .split(/[_\-.\/]|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || s;
}
const stem = (rel: string) => {
  const b = rel.slice(rel.lastIndexOf("/") + 1);
  const d = b.indexOf(".");
  return d > 0 ? b.slice(0, d) : b;
};

// A short, legible feature label for a coarse common category (one feature per category).
const COMMON_FEATURE_LABEL: Record<CommonCategory, string> = {
  "API / Endpoints": "REST Routes",
  "Networking / API-Client": "API Client",
  "Persistence / DB": "Repositories & DB",
  "Data Models": "Data Models",
  "Routing / Middleware": "Middleware",
  "UI Primitives": "UI Primitives",
  "UI Components": "UI Components", // (overridden per-molecule below)
  "State / Store": "State",
  "Auth / Session": "Auth",
  "Config / Env": "Config",
  "Observability / Logging": "Logging",
  "Utilities": "Utilities",
  "Types / Contracts": "Types",
  "Bootstrap": "App Bootstrap",
};

/** Per-file structural signals from the graph (barrel = no defs; types-only = only interfaces). */
function structuralSignals(graph: CallGraph): Map<string, { barrel: boolean; typesOnly: boolean }> {
  const defsByFile = new Map<string, { total: number; iface: number }>();
  for (const n of graph.nodes) {
    if (n.kind === "module" || n.external) continue;
    const d = defsByFile.get(n.file) ?? defsByFile.set(n.file, { total: 0, iface: 0 }).get(n.file)!;
    d.total++;
    if (n.kind === "interface") d.iface++;
  }
  const out = new Map<string, { barrel: boolean; typesOnly: boolean }>();
  for (const n of graph.nodes) {
    if (n.kind !== "module") continue;
    const d = defsByFile.get(n.file);
    out.set(n.file, { barrel: !d || d.total === 0, typesOnly: !!d && d.total > 0 && d.iface === d.total });
  }
  return out;
}

export function assignTiers(vocab: VocabResult, graph: CallGraph): TierAssignment {
  const struct = structuralSignals(graph);
  const moduleCommon = new Map<string, CommonCategory>();
  const commonSignalOf = new Map<string, string>();

  const classify = (rel: string) => {
    const s = struct.get(rel);
    return classifyCommon(rel, s ? { barrel: s.barrel, typesOnly: s.typesOnly } : undefined);
  };

  // business slots (kept domain modules) + a pool of common modules
  const businessSlots: TierSlot[] = [];
  const commonPool: Array<{ rel: string; cat: CommonCategory; signal: string }> = [];
  const pushCommon = (rel: string, hit: { category: CommonCategory; signal: string } | null) => {
    const cat = hit?.category ?? "Utilities"; // core module with no infra fingerprint → shared utility
    const signal = hit?.signal ?? "core:unclassified";
    moduleCommon.set(rel, cat);
    commonSignalOf.set(rel, signal);
    commonPool.push({ rel, cat, signal });
  };

  for (const f of vocab.features) {
    const isCore = f.token === "(core)";
    if (isCore) {
      for (const rel of f.modules) pushCommon(rel, classify(rel));
      continue;
    }
    const business: string[] = [];
    for (const rel of f.modules) {
      const hit = classify(rel);
      if (hit) pushCommon(rel, hit);
      else business.push(rel);
    }
    if (business.length) {
      businessSlots.push({
        key: `business|${f.category}|${f.label}`,
        tier: "business",
        category: f.category,
        label: f.label,
        modules: business.slice().sort(),
        vf: f,
      });
    }
  }

  // group the common pool into features:
  //  - UI Components → per composed component (molecule/organism), label = component name
  //  - every other category → one coarse feature
  const commonSlots = new Map<string, TierSlot>();
  const addTo = (key: string, category: string, label: string, commonCategory: CommonCategory, rel: string, signal: string) => {
    let s = commonSlots.get(key);
    if (!s) commonSlots.set(key, (s = { key, tier: "common", category, label, modules: [], commonCategory, commonSignals: [] }));
    s.modules.push(rel);
    if (!s.commonSignals!.includes(signal)) s.commonSignals!.push(signal);
  };
  for (const { rel, cat, signal } of commonPool) {
    if (cat === "UI Components") {
      const label = titleCase(stem(rel));
      addTo(`common|UI Components|${label}`, "UI Components", label, cat, rel, signal);
    } else {
      addTo(`common|${cat}`, cat, COMMON_FEATURE_LABEL[cat], cat, rel, signal);
    }
  }
  for (const s of commonSlots.values()) s.modules.sort();

  const slots = [...businessSlots, ...commonSlots.values()];
  // deterministic order: business first, then commons by taxonomy order, then label
  const commonRank = (c: string) => {
    const i = COMMON_CATEGORY_ORDER.indexOf(c as CommonCategory);
    return i < 0 ? COMMON_CATEGORY_ORDER.length : i;
  };
  slots.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "business" ? -1 : 1;
    if (a.tier === "common") {
      const r = commonRank(a.category) - commonRank(b.category);
      if (r) return r;
    } else if (a.category !== b.category) {
      return a.category < b.category ? -1 : 1;
    }
    return b.modules.length - a.modules.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  });
  return { slots, moduleCommon };
}

/**
 * Plan 12 — annotate god nodes with `reference` / `referencedBy`. A god node is a *reference*
 * (infra/shared, not a business capability) when its module lives in the common tier, it's a
 * utility hub, or it's called by more than one distinct business feature. Mutates + returns gods.
 */
export function annotateGodReferences(gods: GodNode[], graph: CallGraph, grouping: Grouping): GodNode[] {
  const businessFeatureOf = new Map<string, string>(); // relPath → business featureId
  const commonFiles = new Set<string>();
  for (const c of grouping.business.categories) for (const f of c.features) for (const m of f.modules) businessFeatureOf.set(m.relPath, f.id);
  for (const c of grouping.common.categories) for (const f of c.features) for (const m of f.modules) commonFiles.add(m.relPath);

  // distinct business features that call each target module
  const fanIn = new Map<string, Set<string>>();
  for (const e of projectToModules(graph).edges) {
    if (e.kind !== "calls" && e.kind !== "imports") continue;
    const relA = e.from.replace(/^module:/, "");
    const relB = e.to.replace(/^module:/, "");
    if (relA === relB) continue;
    const fa = businessFeatureOf.get(relA);
    if (!fa) continue;
    (fanIn.get(relB) ?? fanIn.set(relB, new Set()).get(relB)!).add(fa);
  }
  for (const g of gods) {
    const rb = fanIn.get(g.file)?.size ?? 0;
    g.referencedBy = rb;
    g.reference = commonFiles.has(g.file) || g.utilityHub === true || rb > 1;
  }
  return gods;
}
