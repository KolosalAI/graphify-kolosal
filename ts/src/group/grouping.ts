// buildGrouping — assemble the two-tier (Plan 12) category→feature→module trees.
//
// Pipeline: Plan 11 vocabulary clustering → Plan 12 tier assignment (business vs common) →
// ubiquity trim → cross-links, then community/cohesion/god-node accounting per feature. The
// output nests `business` and `common`, each its own category tree (schemaVersion 2).
import type { CallGraph } from "../graph/model.js";
import { rankGodNodes } from "../graph/rank.js";
import { projectToModules } from "../graph/project.js";
import { detectCommunities } from "./community.js";
import { partitionByFolders } from "./folders.js";
import { detectFeatures } from "./vocabulary.js";
import { assignTiers, type TierSlot } from "./tiers.js";
import { analyzeOperations } from "./operations.js";
import { UBIQUITY_ELIGIBLE } from "../common/index.js";
import type { Consumer } from "./types.js";
import type { Category, Feature, GroupFlag, Grouping, GroupingOptions, ModuleRef, Tier } from "./types.js";

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

interface FSlot {
  id: string;
  tier: Tier;
  catLabel: string;
  label: string;
  source: Feature["source"];
  modules: string[];
  vf?: TierSlot["vf"];
  commonSignals?: string[];
}

/** Effective ubiquity cutoff: fraction→×count, int→absolute, floor 5. */
function ubiquityCutoff(businessCount: number, opt?: number): number {
  if (opt != null) {
    const raw = opt > 0 && opt < 1 ? Math.ceil(opt * businessCount) : Math.round(opt);
    return Math.max(5, raw);
  }
  return Math.max(5, Math.ceil(0.5 * businessCount));
}

export function buildGrouping(graph: CallGraph, files: string[], opts: GroupingOptions = {}): Grouping {
  // god nodes, globally ranked once; grouped per file preserving rank order.
  const gods = rankGodNodes(graph, { topN: Number.MAX_SAFE_INTEGER });
  // Distinct symbols can share a qualifiedName (e.g. three `contentService.delete` methods at
  // different spans) → dedupe labels so god-node lists don't repeat the same string.
  const godByFile = new Map<string, string[]>();
  for (const g of gods) { const a = godByFile.get(g.file) ?? godByFile.set(g.file, []).get(g.file)!; if (!a.includes(g.label)) a.push(g.label); }

  const community = detectCommunities(projectToModules(graph));
  const moduleEdges = projectToModules(graph).edges;

  // ── feature cut (Plan 11) → tier assignment (Plan 12), with a folder fallback ──
  const useVocab = opts.featureMode !== "folder";
  const vocab = useVocab ? detectFeatures(files, godByFile, opts.feature) : null;
  const hasRealFeatures = !!vocab && vocab.features.some((f) => f.token !== "(core)");

  let slots: FSlot[] = [];
  let featureMode: "vocabulary" | "folder" = "folder";
  let domainMeta: { domain?: string; domainMatched?: string[]; expectedNotFound?: string[]; excludedTests?: number } = {};
  let moduleCommon = new Map<string, import("../common/index.js").CommonCategory>();

  if (vocab && hasRealFeatures) {
    featureMode = "vocabulary";
    domainMeta = {
      ...(vocab.domain ? { domain: vocab.domain } : {}),
      ...(vocab.domainMatched.length ? { domainMatched: vocab.domainMatched } : {}),
      ...(vocab.expectedNotFound.length ? { expectedNotFound: vocab.expectedNotFound } : {}),
      excludedTests: vocab.excludedTests,
    };
    const { slots: tierSlots, moduleCommon: mc } = assignTiers(vocab, graph);
    moduleCommon = mc;
    const usedIds = new Set<string>();
    for (const ts of tierSlots) {
      const cid = `${ts.tier === "business" ? "biz" : "com"}:${slug(ts.category)}`;
      let fid = `${cid}/${slug(ts.label)}`;
      let k = 2;
      while (usedIds.has(fid)) fid = `${cid}/${slug(ts.label)}-${k++}`;
      usedIds.add(fid);
      slots.push({
        id: fid, tier: ts.tier, catLabel: ts.category, label: ts.label,
        source: ts.vf?.source ?? "folder-fallback", modules: ts.modules, vf: ts.vf,
        commonSignals: ts.commonSignals,
      });
    }
  } else {
    // folder-L1 cut (Plan 08) — everything lands in the business tier (no infra split).
    featureMode = "folder";
    const raw = partitionByFolders(files);
    const used = new Set<string>();
    for (const c of raw) for (const f of c.features) {
      let fid = `biz:${slug(c.label)}/${slug(f.label)}`;
      let k = 2;
      while (used.has(fid)) fid = `biz:${slug(c.label)}/${slug(f.label)}-${k++}`;
      used.add(fid);
      slots.push({ id: fid, tier: "business", catLabel: c.label, label: titleCase(f.label), source: f.source, modules: f.modules });
    }
  }

  // ── ubiquity trim (Plan 12): common modules used by ≥cutoff distinct features → Platform Baseline ──
  const businessCount = slots.filter((s) => s.tier === "business").length;
  const cutoff = ubiquityCutoff(businessCount, opts.ubiquityThreshold);
  const relFeaturePre = new Map<string, string>();
  const relTierPre = new Map<string, Tier>();
  for (const s of slots) for (const m of s.modules) { relFeaturePre.set(m, s.id); relTierPre.set(m, s.tier); }
  const isCommonMod = new Set<string>();
  for (const s of slots) if (s.tier === "common") for (const m of s.modules) isCommonMod.add(m);

  // ubiquity = distinct BUSINESS-feature fan-in (only capability callers count — a barrel/seed
  // importing everything must not inflate it, and shared data-access used by one service stays put).
  const fanIn = new Map<string, Set<string>>(); // target module → distinct business caller featureIds
  for (const e of moduleEdges) {
    if (e.kind !== "calls" && e.kind !== "imports") continue;
    const relA = e.from.replace(/^module:/, "");
    const relB = e.to.replace(/^module:/, "");
    if (relA === relB) continue;
    if (relTierPre.get(relA) !== "business") continue; // only business capabilities count
    const fa = relFeaturePre.get(relA);
    if (!fa || !relFeaturePre.has(relB)) continue;
    (fanIn.get(relB) ?? fanIn.set(relB, new Set()).get(relB)!).add(fa);
  }
  const ubiquitous: string[] = [];
  for (const m of isCommonMod) {
    const cat = moduleCommon.get(m);
    if (cat && UBIQUITY_ELIGIBLE.has(cat) && (fanIn.get(m)?.size ?? 0) >= cutoff) ubiquitous.push(m);
  }
  ubiquitous.sort();
  const ubiquitousSet = new Set(ubiquitous);

  if (ubiquitous.length) {
    // pull ubiquitous modules out of their per-category common features into one Platform Baseline
    for (const s of slots) if (s.tier === "common") s.modules = s.modules.filter((m) => !ubiquitousSet.has(m));
    slots = slots.filter((s) => s.tier === "business" || s.modules.length > 0);
    slots.push({
      id: "com:platform-baseline/platform-baseline", tier: "common", catLabel: "Platform Baseline",
      label: "Platform Baseline", source: "folder-fallback", modules: ubiquitous.slice(),
      commonSignals: ["ubiquitous"],
    });
  }

  // ── membership maps (post-trim) ──
  const relFeature = new Map<string, string>();
  const relCategory = new Map<string, string>();
  const slotById = new Map<string, FSlot>();
  for (const s of slots) {
    slotById.set(s.id, s);
    for (const m of s.modules) { relFeature.set(m, s.id); relCategory.set(m, `${s.tier}:${s.catLabel}`); }
  }

  // ── cross-links (Plan 12): business → common (post-trim), forward + inverse + dataModels ──
  const uses = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  const dataModels = new Map<string, Set<string>>();
  for (const e of moduleEdges) {
    if (e.kind !== "calls" && e.kind !== "imports") continue;
    const relA = e.from.replace(/^module:/, "");
    const relB = e.to.replace(/^module:/, "");
    if (ubiquitousSet.has(relB)) continue; // trimmed: no cross-link noise
    const fa = relFeature.get(relA);
    const fb = relFeature.get(relB);
    if (!fa || !fb || fa === fb) continue;
    const sa = slotById.get(fa)!;
    const sb = slotById.get(fb)!;
    if (sa.tier === "business" && sb.tier === "common") {
      if (sb.catLabel === "Data Models") (dataModels.get(fa) ?? dataModels.set(fa, new Set()).get(fa)!).add(fb);
      else (uses.get(fa) ?? uses.set(fa, new Set()).get(fa)!).add(fb);
      (usedBy.get(fb) ?? usedBy.set(fb, new Set()).get(fb)!).add(fa);
    }
  }

  // ── community/cohesion/god accounting (unchanged machinery) ──
  const commCatCount = new Map<number, Map<string, number>>();
  for (const [rel, cat] of relCategory) {
    const cm = community.get(`module:${rel}`);
    if (cm === undefined) continue;
    (commCatCount.get(cm) ?? commCatCount.set(cm, new Map()).get(cm)!).set(cat, (commCatCount.get(cm)!.get(cat) ?? 0) + 1);
  }
  const commDominantCat = new Map<number, string>();
  for (const [cm, counts] of commCatCount) {
    commDominantCat.set(cm, [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]);
  }

  const internalW = new Map<string, number>();
  const externalW = new Map<string, number>();
  const extByCat = new Map<string, Map<string, number>>();
  const bumpExt = (fid: string, cat: string, w: number) => {
    externalW.set(fid, (externalW.get(fid) ?? 0) + w);
    (extByCat.get(fid) ?? extByCat.set(fid, new Map()).get(fid)!).set(cat, (extByCat.get(fid)!.get(cat) ?? 0) + w);
  };
  for (const e of moduleEdges) {
    if (e.kind !== "calls" && e.kind !== "imports") continue;
    const relA = e.from.replace(/^module:/, "");
    const relB = e.to.replace(/^module:/, "");
    const fa = relFeature.get(relA);
    const fb = relFeature.get(relB);
    if (!fa || !fb) continue;
    const w = e.weight ?? 1;
    if (fa === fb) internalW.set(fa, (internalW.get(fa) ?? 0) + w);
    else {
      const ca = relCategory.get(relA)!;
      const cb = relCategory.get(relB)!;
      if (ca !== cb) { bumpExt(fa, cb, w); bumpExt(fb, ca, w); }
      else { externalW.set(fa, (externalW.get(fa) ?? 0) + w); externalW.set(fb, (externalW.get(fb) ?? 0) + w); }
    }
  }

  const featGods = new Map<string, string[]>();
  const catGods = new Map<string, string[]>();
  for (const g of gods) {
    const fid = relFeature.get(g.file);
    if (fid) { const a = featGods.get(fid) ?? featGods.set(fid, []).get(fid)!; if (a.length < 3 && !a.includes(g.label)) a.push(g.label); }
    const cat = relCategory.get(g.file);
    if (cat) { const a = catGods.get(cat) ?? catGods.set(cat, []).get(cat)!; if (a.length < 3 && !a.includes(g.label)) a.push(g.label); }
  }

  // ── assemble Feature objects ──
  const bySlot = new Map<string, Feature>();
  let totalFlags = 0;
  for (const slot of slots) {
    const mods = slot.modules;
    const modules: ModuleRef[] = mods.map((rel) => ({ id: `module:${rel}`, relPath: rel, godNodes: (godByFile.get(rel) ?? []).slice(0, 3) }));

    const commCounts = new Map<number, number>();
    for (const rel of mods) { const cm = community.get(`module:${rel}`); if (cm !== undefined) commCounts.set(cm, (commCounts.get(cm) ?? 0) + 1); }
    const domShare = commCounts.size ? Math.max(...commCounts.values()) / mods.length : 1;

    const iW = internalW.get(slot.id) ?? 0;
    const eW = externalW.get(slot.id) ?? 0;
    const cohesion = iW + eW === 0 ? 1 : iW / (iW + eW);

    const flags: GroupFlag[] = [];
    const catKey = `${slot.tier}:${slot.catLabel}`;
    const misplaced = mods.filter((rel) => {
      const cm = community.get(`module:${rel}`);
      return cm !== undefined && commDominantCat.get(cm) && commDominantCat.get(cm) !== catKey;
    });
    if (misplaced.length) flags.push({ kind: "misplaced", detail: `${misplaced.slice(0, 3).join(", ")} couple elsewhere` });
    const extCats = extByCat.get(slot.id);
    if (eW > iW && extCats && extCats.size) {
      const topCat = [...extCats.entries()].sort((a, b) => b[1] - a[1])[0][0];
      flags.push({ kind: "hidden-coupling", detail: `mostly coupled to ${titleCase(topCat.replace(/^(business|common):/, ""))}` });
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
      tier: slot.tier,
      ...(slot.tier === "common" && slot.commonSignals?.length ? { commonSignals: [...new Set(slot.commonSignals)] } : {}),
      ...(uses.get(slot.id)?.size ? { uses: [...uses.get(slot.id)!].sort() } : {}),
      ...(usedBy.get(slot.id)?.size ? { usedBy: [...usedBy.get(slot.id)!].sort() } : {}),
      ...(dataModels.get(slot.id)?.size ? { dataModels: [...dataModels.get(slot.id)!].sort() } : {}),
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

  // ── Plan 13: split business features into operations (verb+noun), page→consumer references ──
  const consumers: Consumer[] = [];
  let operationCount = 0;
  for (const f of bySlot.values()) {
    if (f.tier !== "business") continue;
    const a = analyzeOperations(f.modules.map((m) => m.relPath), graph);
    if (!a.split) continue; // legibility gate: <2 business ops → keep the feature whole
    f.ops = a.ops.map((o) => ({ key: `${f.id}#${o.key}`, label: o.label, verb: o.verb, entry: o.entry, symbols: o.symbols, modules: o.modules }));
    f.description = `${a.ops.length} operations · ${f.description}`;
    operationCount += a.ops.length;
    for (const con of a.consumers) consumers.push({ ...con, references: con.references.map((r) => `${f.id}#${r}`) });
  }

  // ── assemble category trees per tier ──
  const buildCategories = (tier: Tier): Category[] => {
    const byCat = new Map<string, FSlot[]>();
    const order: string[] = [];
    for (const s of slots) {
      if (s.tier !== tier) continue;
      if (!byCat.has(s.catLabel)) { byCat.set(s.catLabel, []); order.push(s.catLabel); }
      byCat.get(s.catLabel)!.push(s);
    }
    const cats = order.map((cat) => {
      const features = byCat.get(cat)!.map((s) => bySlot.get(s.id)!).filter(Boolean);
      const moduleCount = features.reduce((n, f) => n + f.modules.length, 0);
      const catKey = `${tier}:${cat}`;
      return {
        id: `${tier === "business" ? "biz" : "com"}:${slug(cat)}`,
        // business categories are folder/app-area tokens → titleCase; common categories are
        // already display-ready taxonomy names ("API / Endpoints") → keep verbatim.
        label: tier === "common" ? cat : titleCase(cat),
        description: catGods.get(catKey)?.[0] ? `Anchored by ${catGods.get(catKey)![0]}` : `${moduleCount} modules`,
        features,
        moduleCount,
        godNodes: catGods.get(catKey) ?? [],
        labeledBy: "fallback" as const,
        tier,
      };
    });
    cats.sort((a, b) => b.moduleCount - a.moduleCount || (a.label < b.label ? -1 : 1));
    return cats;
  };
  const business = { categories: buildCategories("business") };
  const common = { categories: buildCategories("common") };

  const businessFeatureCount = business.categories.reduce((n, c) => n + c.features.length, 0);
  const commonFeatureCount = common.categories.reduce((n, c) => n + c.features.length, 0);
  const categoryCount = business.categories.length + common.categories.length;

  return {
    business,
    common,
    meta: {
      schemaVersion: 2,
      moduleCount: files.length,
      categoryCount,
      featureCount: businessFeatureCount + commonFeatureCount,
      llm: false,
      flags: totalFlags,
      uncategorized: 0,
      featureMode,
      businessFeatureCount,
      commonFeatureCount,
      ubiquityThreshold: cutoff,
      ...(ubiquitous.length ? { ubiquitous } : {}),
      operationCount,
      ...(consumers.length ? { consumers } : {}),
      ...domainMeta,
    },
  };
}
