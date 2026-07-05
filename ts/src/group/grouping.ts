// buildGrouping — assemble the category→feature→module tree, then validate it against
// community detection (agreement + flags) and rank god nodes per level. Deterministic;
// fallback labels (Stage 5 LLM adds real ones).
//
// Plan 11: the feature cut is VOCABULARY CLUSTERING (Pillar A) + domain-dictionary
// enforcement (Pillar C), replacing Plan 08's folder-L1 cut which only worked on
// feature-sliced repos. The folder cut remains as a fallback (flat/token-less corpora,
// or featureMode:"folder").
import type { CallGraph } from "../graph/model.js";
import { rankGodNodes } from "../graph/rank.js";
import { projectToModules } from "../graph/project.js";
import { detectCommunities } from "./community.js";
import { partitionByFolders } from "./folders.js";
import { detectFeatures, type VocabFeature } from "./vocabulary.js";
import type { Category, Feature, GroupFlag, Grouping, GroupingOptions, ModuleRef } from "./types.js";

function titleCase(s: string): string {
  if (s === "(root)") return "Root";
  if (s === "(core)") return "Core";
  return s
    .split(/[_\-.\/]|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || s;
}
const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "x";

// One assembled slot: a feature-in-a-category, carrying its raw membership + (Plan 11) the
// vocabulary feature it came from so per-feature evidence flows onto the final Feature.
interface FSlot {
  id: string;
  catLabel: string;
  label: string;
  source: Feature["source"];
  modules: string[];
  vf?: VocabFeature;
}

export function buildGrouping(graph: CallGraph, files: string[], opts: GroupingOptions = {}): Grouping {
  // god nodes, globally ranked once; grouped per file preserving rank order.
  const gods = rankGodNodes(graph, { topN: Number.MAX_SAFE_INTEGER });
  const godByFile = new Map<string, string[]>();
  for (const g of gods) (godByFile.get(g.file) ?? godByFile.set(g.file, []).get(g.file)!).push(g.label);

  // community detection on the module graph (the validator).
  const community = detectCommunities(projectToModules(graph));

  // ── feature cut: vocabulary clustering (Plan 11) with a folder fallback ──────
  const catOrder: string[] = [];
  const slotsByCat = new Map<string, FSlot[]>();
  let domainMeta: { domain?: string; domainMatched?: string[]; expectedNotFound?: string[]; excludedTests?: number } = {};
  let featureMode: "vocabulary" | "folder" = "folder";

  const useVocab = opts.featureMode !== "folder";
  const vocab = useVocab ? detectFeatures(files, godByFile, opts.feature) : null;
  const hasRealFeatures = !!vocab && vocab.features.some((f) => f.token !== "(core)");

  const pushSlot = (catLabel: string, slot: FSlot) => {
    if (!slotsByCat.has(catLabel)) { slotsByCat.set(catLabel, []); catOrder.push(catLabel); }
    slotsByCat.get(catLabel)!.push(slot);
  };

  if (vocab && hasRealFeatures) {
    featureMode = "vocabulary";
    domainMeta = {
      ...(vocab.domain ? { domain: vocab.domain } : {}),
      ...(vocab.domainMatched.length ? { domainMatched: vocab.domainMatched } : {}),
      ...(vocab.expectedNotFound.length ? { expectedNotFound: vocab.expectedNotFound } : {}),
      excludedTests: vocab.excludedTests,
    };
    const usedIds = new Set<string>();
    for (const vf of vocab.features) {
      const cid = `cat:${slug(vf.category)}`;
      let fid = `${cid}/${slug(vf.label)}`;
      let k = 2;
      while (usedIds.has(fid)) fid = `${cid}/${slug(vf.label)}-${k++}`;
      usedIds.add(fid);
      pushSlot(vf.category, { id: fid, catLabel: vf.category, label: vf.label, source: vf.source, modules: vf.modules, vf });
    }
  } else {
    // folder-L1 cut (Plan 08)
    const raw = partitionByFolders(files);
    for (const c of raw) {
      const cid = `cat:${slug(c.label)}`;
      const used = new Set<string>();
      for (const f of c.features) {
        let fid = `${cid}/${slug(f.label)}`;
        let k = 2;
        while (used.has(fid)) fid = `${cid}/${slug(f.label)}-${k++}`;
        used.add(fid);
        pushSlot(c.label, { id: fid, catLabel: c.label, label: titleCase(f.label), source: f.source, modules: f.modules });
      }
    }
  }

  // flatten slots + membership maps
  const featSlots: FSlot[] = [];
  const relFeature = new Map<string, string>(); // relPath -> featureId
  const relCategory = new Map<string, string>(); // relPath -> category label
  for (const cat of catOrder) {
    for (const slot of slotsByCat.get(cat)!) {
      featSlots.push(slot);
      for (const m of slot.modules) { relFeature.set(m, slot.id); relCategory.set(m, cat); }
    }
  }

  // community dominant category (for misplaced detection)
  const commCatCount = new Map<number, Map<string, number>>();
  for (const [rel, cat] of relCategory) {
    const cm = community.get(`module:${rel}`);
    if (cm === undefined) continue;
    const inner = commCatCount.get(cm) ?? commCatCount.set(cm, new Map()).get(cm)!;
    inner.set(cat, (inner.get(cat) ?? 0) + 1);
  }
  const commDominantCat = new Map<number, string>();
  for (const [cm, counts] of commCatCount) {
    commDominantCat.set(cm, [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]);
  }

  // edge accounting for cohesion / external coupling (module-projected edges)
  const internalW = new Map<string, number>();
  const externalW = new Map<string, number>();
  const extByCat = new Map<string, Map<string, number>>();
  const bumpExt = (fid: string, cat: string, w: number) => {
    externalW.set(fid, (externalW.get(fid) ?? 0) + w);
    const m = extByCat.get(fid) ?? extByCat.set(fid, new Map()).get(fid)!;
    m.set(cat, (m.get(cat) ?? 0) + w);
  };
  for (const e of projectToModules(graph).edges) {
    if (e.kind !== "calls" && e.kind !== "imports") continue;
    const relA = e.from.replace(/^module:/, "");
    const relB = e.to.replace(/^module:/, "");
    const fa = relFeature.get(relA);
    const fb = relFeature.get(relB);
    if (!fa || !fb) continue;
    const w = e.weight ?? 1;
    if (fa === fb) {
      internalW.set(fa, (internalW.get(fa) ?? 0) + w);
    } else {
      const ca = relCategory.get(relA)!;
      const cb = relCategory.get(relB)!;
      if (ca !== cb) { bumpExt(fa, cb, w); bumpExt(fb, ca, w); }
      else { externalW.set(fa, (externalW.get(fa) ?? 0) + w); externalW.set(fb, (externalW.get(fb) ?? 0) + w); }
    }
  }

  // per-feature/category god nodes (top 3, global rank order)
  const featGods = new Map<string, string[]>();
  const catGods = new Map<string, string[]>();
  for (const g of gods) {
    const fid = relFeature.get(g.file);
    if (fid) { const a = featGods.get(fid) ?? featGods.set(fid, []).get(fid)!; if (a.length < 3) a.push(g.label); }
    const cat = relCategory.get(g.file);
    if (cat) { const a = catGods.get(cat) ?? catGods.set(cat, []).get(cat)!; if (a.length < 3) a.push(g.label); }
  }

  // assemble features
  const bySlot = new Map<string, Feature>();
  let totalFlags = 0;
  for (const slot of featSlots) {
    const mods = slot.modules;
    const modules: ModuleRef[] = mods.map((rel) => ({ id: `module:${rel}`, relPath: rel, godNodes: (godByFile.get(rel) ?? []).slice(0, 3) }));

    // structural agreement: share of modules in the dominant community
    const commCounts = new Map<number, number>();
    for (const rel of mods) { const cm = community.get(`module:${rel}`); if (cm !== undefined) commCounts.set(cm, (commCounts.get(cm) ?? 0) + 1); }
    const domShare = commCounts.size ? Math.max(...commCounts.values()) / mods.length : 1;

    // cohesion
    const iW = internalW.get(slot.id) ?? 0;
    const eW = externalW.get(slot.id) ?? 0;
    const cohesion = iW + eW === 0 ? 1 : iW / (iW + eW);

    // flags
    const flags: GroupFlag[] = [];
    const misplaced = mods.filter((rel) => {
      const cm = community.get(`module:${rel}`);
      return cm !== undefined && commDominantCat.get(cm) && commDominantCat.get(cm) !== slot.catLabel;
    });
    if (misplaced.length) flags.push({ kind: "misplaced", detail: `${misplaced.slice(0, 3).join(", ")} couple to ${commDominantCat.get(community.get(`module:${misplaced[0]}`)!)}` });
    const extCats = extByCat.get(slot.id);
    if (eW > iW && extCats && extCats.size) {
      const topCat = [...extCats.entries()].sort((a, b) => b[1] - a[1])[0][0];
      flags.push({ kind: "hidden-coupling", detail: `mostly coupled to ${titleCase(topCat)}` });
    }
    totalFlags += flags.length;

    const vf = slot.vf;
    const feature: Feature = {
      id: slot.id,
      label: slot.label,
      description: featGods.get(slot.id)?.[0] ? `Centered on ${featGods.get(slot.id)![0]}` : `${mods.length} module${mods.length > 1 ? "s" : ""}`,
      source: slot.source,
      modules,
      godNodes: featGods.get(slot.id) ?? [],
      cohesion: Number(cohesion.toFixed(3)),
      structuralAgreement: Number(domShare.toFixed(3)),
      flags,
      labeledBy: "fallback",
      ...(vf && vf.token !== "(core)"
        ? {
            domainToken: vf.token,
            ...(vf.aliases.length ? { aliases: vf.aliases } : {}),
            ...(vf.canonical ? { canonical: vf.canonical } : {}),
            ...(vf.domain ? { domain: vf.domain } : {}),
            confidence: vf.confidence,
            evidence: { crossLayerSpread: vf.crossLayerSpread, ...(vf.entryPoints ? { entryPoints: vf.entryPoints } : {}) },
          }
        : {}),
    };
    bySlot.set(slot.id, feature);
  }

  // assemble categories (deterministic: catOrder)
  const categories: Category[] = catOrder.map((cat) => {
    const features = slotsByCat.get(cat)!.map((s) => bySlot.get(s.id)!).filter(Boolean);
    const moduleCount = features.reduce((n, f) => n + f.modules.length, 0);
    return {
      id: `cat:${slug(cat)}`,
      label: titleCase(cat),
      description: catGods.get(cat)?.[0] ? `Anchored by ${catGods.get(cat)![0]}` : `${moduleCount} modules`,
      features,
      moduleCount,
      godNodes: catGods.get(cat) ?? [],
      labeledBy: "fallback",
    };
  });
  // biggest categories first
  categories.sort((a, b) => b.moduleCount - a.moduleCount || (a.label < b.label ? -1 : 1));

  const uncategorized = categories.filter((c) => c.label === "Root").reduce((n, c) => n + c.moduleCount, 0);
  return {
    categories,
    meta: {
      moduleCount: files.length,
      categoryCount: categories.length,
      featureCount: featSlots.length,
      llm: false,
      flags: totalFlags,
      uncategorized,
      featureMode,
      ...domainMeta,
    },
  };
}
