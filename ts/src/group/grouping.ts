// buildGrouping (Plan 08, Stages 1–4): assemble the category→feature→module tree from the
// folder/naming backbone, then validate it against community detection (agreement + flags)
// and rank god nodes per level. Deterministic; fallback labels (Stage 5 LLM adds real ones).
import type { CallGraph } from "../graph/model.js";
import { rankGodNodes } from "../graph/rank.js";
import { projectToModules } from "../graph/project.js";
import { detectCommunities } from "./community.js";
import { partitionByFolders } from "./folders.js";
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

export function buildGrouping(graph: CallGraph, files: string[], _opts: GroupingOptions = {}): Grouping {
  const raw = partitionByFolders(files);

  // god nodes, globally ranked once; grouped per file preserving rank order.
  const gods = rankGodNodes(graph, { topN: Number.MAX_SAFE_INTEGER });
  const godByFile = new Map<string, string[]>();
  for (const g of gods) (godByFile.get(g.file) ?? godByFile.set(g.file, []).get(g.file)!).push(g.label);

  // community detection on the module graph (the validator).
  const community = detectCommunities(projectToModules(graph));

  // assign ids + membership maps
  const relFeature = new Map<string, string>(); // relPath -> featureId
  const relCategory = new Map<string, string>(); // relPath -> category label
  const catIds = new Map<string, string>();
  type FSlot = { id: string; catLabel: string; raw: { label: string; source: "folder" | "name"; modules: string[] } };
  const featSlots: FSlot[] = [];
  for (const c of raw) {
    const cid = `cat:${slug(c.label)}`;
    catIds.set(c.label, cid);
    const used = new Set<string>();
    for (const f of c.features) {
      let fid = `${cid}/${slug(f.label)}`;
      let k = 2;
      while (used.has(fid)) fid = `${cid}/${slug(f.label)}-${k++}`;
      used.add(fid);
      featSlots.push({ id: fid, catLabel: c.label, raw: f });
      for (const m of f.modules) { relFeature.set(m, fid); relCategory.set(m, c.label); }
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
    const mods = slot.raw.modules;
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

    const feature: Feature = {
      id: slot.id,
      label: titleCase(slot.raw.label),
      description: featGods.get(slot.id)?.[0] ? `Centered on ${featGods.get(slot.id)![0]}` : `${mods.length} module${mods.length > 1 ? "s" : ""}`,
      source: slot.raw.source,
      modules,
      godNodes: featGods.get(slot.id) ?? [],
      cohesion: Number(cohesion.toFixed(3)),
      structuralAgreement: Number(domShare.toFixed(3)),
      flags,
      labeledBy: "fallback",
    };
    bySlot.set(slot.id, feature);
  }

  // assemble categories
  const categories: Category[] = raw.map((c) => {
    const features = c.features.map((_, i) => bySlot.get(featSlots.find((s) => s.catLabel === c.label && s.raw === c.features[i])!.id)!).filter(Boolean);
    const moduleCount = features.reduce((n, f) => n + f.modules.length, 0);
    return {
      id: catIds.get(c.label)!,
      label: titleCase(c.label),
      description: catGods.get(c.label)?.[0] ? `Anchored by ${catGods.get(c.label)![0]}` : `${moduleCount} modules`,
      features,
      moduleCount,
      godNodes: catGods.get(c.label) ?? [],
      labeledBy: "fallback",
    };
  });

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
    },
  };
}
