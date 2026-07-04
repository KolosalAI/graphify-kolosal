// Stages 1–2 (Plan 08): partition modules into category → feature by folder structure,
// refined by naming for flat repos. Pure, deterministic, no LLM.

export interface RawFeature { label: string; source: "folder" | "name"; modules: string[]; }
export interface RawCategory { label: string; features: RawFeature[]; }

const ROOT = "(root)";
const CORE = "(core)";

/** Drop the leading directory segments shared by every path (keep filenames). */
function stripCommonDir(paths: string[]): Map<string, string[]> {
  const split = paths.map((p) => p.split("/"));
  let common = 0;
  if (split.length > 1) {
    const first = split[0];
    outer: for (; common < first.length - 1; common++) {
      const seg = first[common];
      for (const s of split) if (s.length - 1 <= common || s[common] !== seg) break outer;
    }
  }
  return new Map(paths.map((p, i) => [p, split[i].slice(common)]));
}

/** Split a filename stem into words and take the first as a grouping token. */
function nameToken(relPath: string): string {
  let base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  const first = base.split(/[_\-.]|(?<=[a-z0-9])(?=[A-Z])/)[0];
  return (first || base).toLowerCase();
}

/**
 * Category = first dir after common prefix; feature = next dir, else a "(core)" bucket
 * (split by name token when the category has no sub-folders, mainly for flat repos).
 */
export function partitionByFolders(files: string[]): RawCategory[] {
  const stripped = stripCommonDir(files);
  // category -> feature(or "") -> modules
  const cats = new Map<string, Map<string, string[]>>();
  for (const rel of files) {
    const segs = stripped.get(rel)!;
    const dirs = segs.slice(0, -1);
    const category = dirs[0] ?? ROOT;
    const feature = dirs[1] ?? ""; // "" = files directly under the category
    const feats = cats.get(category) ?? cats.set(category, new Map()).get(category)!;
    (feats.get(feature) ?? feats.set(feature, []).get(feature)!).push(rel);
  }

  const out: RawCategory[] = [];
  for (const [category, feats] of cats) {
    const features: RawFeature[] = [];
    for (const [feature, modules] of feats) {
      if (feature !== "") {
        features.push({ label: feature, source: "folder", modules });
        continue;
      }
      // "(core)" bucket: split by name token only when there's no folder signal
      // (flat root, or a single-token category). Otherwise keep as one "(core)" feature.
      const flat = category === ROOT || feats.size === 1;
      if (flat && modules.length >= 3) {
        const byToken = new Map<string, string[]>();
        for (const m of modules) (byToken.get(nameToken(m)) ?? byToken.set(nameToken(m), []).get(nameToken(m))!).push(m);
        if (byToken.size >= 2) {
          for (const [tok, mods] of byToken) features.push({ label: tok, source: "name", modules: mods });
          continue;
        }
      }
      features.push({ label: feats.size === 1 ? category : CORE, source: "folder", modules });
    }
    out.push({ label: category, features });
  }
  // deterministic order: by module count desc, then label
  out.sort((a, b) => tot(b) - tot(a) || (a.label < b.label ? -1 : 1));
  for (const c of out) c.features.sort((a, b) => b.modules.length - a.modules.length || (a.label < b.label ? -1 : 1));
  return out;
}

const tot = (c: RawCategory) => c.features.reduce((n, f) => n + f.modules.length, 0);
