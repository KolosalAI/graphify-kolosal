// Plan 11 — Pillar A (vocabulary clustering) + Pillar C (domain-dictionary enforcement).
//
// Features are ROWS that cross layers, named by the same domain noun in every language;
// layers (pages/services/repositories/routes) are COLUMNS. Folders slice by column and god
// nodes rank plumbing — neither sees a feature. This clusters modules by their *domain token*
// (filename/path residue after stripping role/layer affixes), scores clusters by how many
// distinct layers they span, then canonicalizes the surviving features against a base domain
// dictionary (src/domain/) when a domain is confidently detected.
//
// Pure, deterministic, language-agnostic. No LLM, no framework knowledge required.
import { canonicalFeature, detectDomain } from "../domain/index.js";
import { isTestPath } from "./tests.js";

// ── knobs (small, shared, extensible) ────────────────────────────────────────

// Role/layer words stripped from a name to expose the domain noun (CartPage → cart).
const ROLE_AFFIXES = new Set<string>([
  "controller", "service", "svc", "repository", "repo", "handler", "model", "models",
  "dto", "entity", "view", "page", "screen", "component", "hook", "use",
  "manager", "provider", "store", "api", "client", "route", "router", "middleware",
  "util", "utils", "helper", "helpers", "config", "index", "main", "app", "base",
  "common", "type", "types", "context", "container", "wrapper", "factory", "impl",
  "test", "tests", "spec", "specs", "mock", "mocks", "fixture", "e2e",
]);

// Directory segments that are LAYERS (columns) — used for stripping path tokens.
const LAYER_DIRS = new Set<string>([
  "pages", "page", "components", "component", "hooks", "hook", "services", "service",
  "repositories", "repository", "routes", "route", "models", "model", "middleware",
  "controllers", "controller", "views", "view", "screens", "screen", "context", "contexts",
  "store", "stores", "providers", "provider", "db", "database", "data", "dao", "resolvers",
  "handlers", "endpoints", "atoms", "molecules", "organisms", "templates", "design-system",
  "util", "utils", "helpers", "lib", "config", "constants", "types", "styles", "assets",
  "public", "api", "graphql", "schema", "schemas",
]);

// FEATURE-BEARING layers only — these count toward crossLayerSpread. Plumbing columns
// (utils/config/styles/assets/…) are present in every feature, so they must NOT inflate
// spread, or every leaf that touches config would look cross-layer.
const FEATURE_LAYERS = new Set<string>([
  "pages", "page", "components", "hooks", "hook", "services", "service", "repositories",
  "repository", "routes", "route", "models", "model", "middleware", "controllers",
  "controller", "views", "view", "screens", "screen", "context", "contexts", "store",
  "stores", "providers", "provider", "db", "database", "data", "dao", "resolvers",
  "handlers", "endpoints", "api", "graphql",
]);

// Component sub-layers collapse to a single "components" layer, so an atomic-design tree
// (components/atoms/Button.jsx) is ONE layer, not two — UI primitives aren't features.
const COMPONENT_SUBLAYERS = new Set<string>(["atoms", "molecules", "organisms", "templates", "design-system"]);

// A module living in one of these layers is feature-worthy even at spread 1 (entry points /
// UI pages ARE features). Approximates Pillar B "page-by-convention" recovery without config.
const ANCHOR_LAYERS = new Set<string>([
  "pages", "page", "routes", "route", "screens", "screen", "views", "view",
  "controllers", "controller", "handlers", "endpoints", "resolvers", "commands",
]);

// App-area / scaffolding segments: not layers, not domain tokens. First app-area is the
// category fallback when no domain dictionary matches (client / server / …).
const APP_AREA_DIRS = new Set<string>([
  "client", "server", "frontend", "backend", "web", "mobile", "admin", "api-server",
  "worker", "gateway", "service", "services", "packages", "apps",
]);
const SCAFFOLD_DIRS = new Set<string>(["src", "source", "app", "lib", "internal", "pkg", "cmd"]);

// Config / manifest / tooling files: parseable but not domain code — never a feature.
const CONFIG_STEMS = new Set<string>([
  "dockerfile", "makefile", "package", "package-lock", "tsconfig", "jsconfig", "eslint",
  "prettier", "babel", "webpack", "rollup", "vite", "vitest", "jest", "playwright", "cypress",
  "readme", "license", "changelog", "gitignore", "editorconfig", "nginx", "gulpfile", "gruntfile",
]);

export interface FeatureConfig {
  roleAffixes?: string[]; // extra role words to strip (merged with defaults)
  layerDirs?: string[]; // extra layer dirs (merged)
  stopTokens?: string[]; // tokens that never form a feature (merged)
  minFeatureSize?: number; // default 2 when spread < 2 and not an anchor-layer module
  excludeTests?: boolean; // default true — test files never form features
}

export interface VocabFeature {
  token: string; // singularized cluster key ("cart", "product search")
  label: string; // human label (canonical wins, else titled token)
  category: string; // reconciled category label
  modules: string[]; // member relPaths (one feature per module)
  layers: string[]; // distinct layer dirs the members span
  crossLayerSpread: number;
  aliases: string[]; // surface variants + prior token when canonicalized
  canonical?: string; // Pillar C dictionary label, when matched
  domain?: string; // detected domain when this feature was canonicalized
  entryPoints?: string[]; // Pillar B: anchor-layer modules (route/page evidence)
  source: "token" | "token+entry" | "dictionary" | "folder-fallback";
  confidence: "high" | "medium" | "low";
}

export interface VocabResult {
  features: VocabFeature[];
  domain: string | null;
  domainMatched: string[];
  expectedNotFound: string[]; // dictionary features with no code (advisory)
  excludedTests: number;
  coreModules: number; // leftover plumbing folded into per-category Core buckets
}

// ── tokenization ─────────────────────────────────────────────────────────────

/** Split camelCase / snake_case / kebab-case / dotted into lowercased words. */
function splitWords(s: string): string[] {
  return s
    .split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

/** Naive English singularization for stable cluster keys (products → product). */
function singularize(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("ss")) return w;
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ") || s;
}

const fileStem = (rel: string): string => {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

interface ModView {
  rel: string;
  layers: string[]; // recognized layer dirs on the path
  appArea: string | null; // first app-area segment (category fallback)
  anchor: boolean; // sits in an anchor layer
  tokenWords: string[]; // domain residue words (already affix-stripped)
}

/** Longest run of leading dir segments shared by every path (keep at least the filename). */
function commonPrefixLen(paths: string[]): number {
  if (paths.length < 2) return 0;
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  let common = 0;
  outer: for (; common < first.length - 1; common++) {
    const seg = first[common];
    for (const s of split) if (s.length - 1 <= common || s[common] !== seg) break outer;
  }
  return common;
}

function analyzeModule(rel: string, analysisPath: string, affixes: Set<string>, layerDirs: Set<string>, godTokens: string[]): ModView {
  const segs = analysisPath.split("/");
  const dirs = segs.slice(0, -1);
  const layers: string[] = [];
  let appArea: string | null = null;
  let anchor = false;
  for (const d of dirs) {
    const dl = d.toLowerCase();
    // component sub-layers collapse to "components"; only feature-bearing layers count.
    const norm = COMPONENT_SUBLAYERS.has(dl) ? "components" : dl;
    if (FEATURE_LAYERS.has(norm)) layers.push(norm);
    if (ANCHOR_LAYERS.has(dl)) anchor = true;
    if (appArea === null && APP_AREA_DIRS.has(dl)) appArea = dl;
  }
  if (appArea === null) {
    const first = dirs.find((d) => !SCAFFOLD_DIRS.has(d.toLowerCase()));
    appArea = first ? first.toLowerCase() : dirs[0]?.toLowerCase() ?? null;
  }

  // config/manifest files carry no domain token → straight to the Core bucket.
  const stem = fileStem(analysisPath).toLowerCase();
  if (CONFIG_STEMS.has(stem)) return { rel, layers: [...new Set(layers)], appArea, anchor: false, tokenWords: [] };

  // domain residue: filename stem first; fall back to non-layer path segments, then god symbols.
  const strip = (words: string[]) => words.filter((w) => !affixes.has(w));
  let residue = strip(splitWords(fileStem(analysisPath)));
  if (!residue.length) {
    const pathWords = dirs
      .filter((d) => !layerDirs.has(d.toLowerCase()) && !APP_AREA_DIRS.has(d.toLowerCase()) && !SCAFFOLD_DIRS.has(d.toLowerCase()))
      .flatMap(splitWords);
    residue = strip(pathWords);
  }
  if (!residue.length && godTokens.length) {
    // sanitize synthetic symbol names (<lambda@…>, <anonymous>) before tokenizing.
    const clean = godTokens.filter((t) => !/[<>]|lambda|anonymous/i.test(t));
    residue = strip(clean.flatMap(splitWords)).slice(0, 2);
  }
  return { rel, layers: [...new Set(layers)], appArea, anchor, tokenWords: residue };
}

// ── main ─────────────────────────────────────────────────────────────────────

export function detectFeatures(
  files: string[],
  godByFile: Map<string, string[]> = new Map(),
  opts: FeatureConfig = {},
): VocabResult {
  const affixes = new Set(ROLE_AFFIXES);
  for (const a of opts.roleAffixes ?? []) affixes.add(a.toLowerCase());
  const layerDirs = new Set(LAYER_DIRS);
  for (const l of opts.layerDirs ?? []) layerDirs.add(l.toLowerCase());
  const stop = new Set((opts.stopTokens ?? []).map((s) => s.toLowerCase()));
  const excludeTests = opts.excludeTests ?? true;
  const minSize = opts.minFeatureSize ?? 2;

  // 1. filter tests, analyze each module → domain residue + layer profile.
  //    Strip the dir prefix shared by every module (e.g. an extracted "sample_source_planout/"
  //    root) so client/server become the app-areas, not a leaked top segment.
  let excludedTests = 0;
  const kept = files.filter((rel) => !(excludeTests && isTestPath(rel)));
  excludedTests = files.length - kept.length;
  const strip = commonPrefixLen(kept);
  const views: ModView[] = kept.map((rel) =>
    analyzeModule(rel, rel.split("/").slice(strip).join("/"), affixes, layerDirs, godByFile.get(rel) ?? []),
  );

  // 2. cluster by singularized token key (one primary feature per module)
  interface Cluster {
    key: string;
    surfaces: Map<string, number>; // surface form -> count (label vote)
    modules: string[];
    layers: Set<string>;
    anchorMods: string[];
    appAreas: Map<string, number>;
  }
  const clusters = new Map<string, Cluster>();
  const coreByArea = new Map<string, string[]>(); // leftover plumbing per app-area
  for (const v of views) {
    if (!v.tokenWords.length) { push(coreByArea, v.appArea ?? "(root)", v.rel); continue; }
    const key = v.tokenWords.map(singularize).join(" ");
    if (stop.has(key)) { push(coreByArea, v.appArea ?? "(root)", v.rel); continue; }
    const surface = v.tokenWords.join(" ");
    let c = clusters.get(key);
    if (!c) clusters.set(key, (c = { key, surfaces: new Map(), modules: [], layers: new Set(), anchorMods: [], appAreas: new Map() }));
    c.surfaces.set(surface, (c.surfaces.get(surface) ?? 0) + 1);
    c.modules.push(v.rel);
    for (const l of v.layers) c.layers.add(l);
    if (v.anchor) c.anchorMods.push(v.rel);
    if (v.appArea) c.appAreas.set(v.appArea, (c.appAreas.get(v.appArea) ?? 0) + 1);
  }

  // 3. score clusters → features vs Core; a cluster is a feature when it spans ≥2 layers,
  //    owns an anchor-layer (page/route) module, or reaches minFeatureSize.
  const feats: VocabFeature[] = [];
  for (const c of clusters.values()) {
    const spread = c.layers.size;
    const isFeature = spread >= 2 || c.anchorMods.length > 0 || c.modules.length >= minSize;
    if (!isFeature) { for (const m of c.modules) push(coreByArea, dominant(c.appAreas) ?? "(root)", m); continue; }
    const surface = [...c.surfaces.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    const confidence: VocabFeature["confidence"] =
      spread >= 2 && c.anchorMods.length ? "high" : spread >= 2 || c.anchorMods.length ? "medium" : "low";
    feats.push({
      token: c.key,
      label: titleCase(surface),
      category: titleCase(dominant(c.appAreas) ?? "(core)"),
      modules: c.modules.slice().sort(),
      layers: [...c.layers].sort(),
      crossLayerSpread: spread,
      aliases: [...c.surfaces.keys()].filter((s) => s !== surface).sort(),
      entryPoints: c.anchorMods.length ? c.anchorMods.slice().sort() : undefined,
      source: c.anchorMods.length ? "token+entry" : "token",
      confidence,
    });
  }

  // 4. Pillar C — detect the business domain from the whole vocabulary, then canonicalize.
  const allTokens = feats.flatMap((f) => [f.token, ...f.aliases]);
  const match = detectDomain(allTokens);
  const expectedNotFound: string[] = [];
  if (match) {
    const hit = new Set<string>();
    for (const f of feats) {
      const cf = canonicalFeature(f.token, match.domain)
        ?? f.aliases.map((a) => canonicalFeature(a, match.domain)).find(Boolean)
        ?? null;
      if (!cf) continue;
      hit.add(cf.canonical);
      if (f.label !== cf.canonical && !f.aliases.includes(f.token)) f.aliases = [f.token, ...f.aliases].filter((a, i, arr) => arr.indexOf(a) === i);
      // Precedence: route/entry name (B) already set token+entry; dictionary canonical (C)
      // standardizes the label + category. Bump to high — the domain vocab confirms it.
      f.canonical = cf.canonical;
      f.domain = match.domain;
      f.label = cf.canonical;
      f.category = cf.category;
      f.source = f.source === "token+entry" ? "token+entry" : "dictionary";
      f.confidence = "high";
    }
    for (const c of match.matched) if (!hit.has(c)) { /* matched via token */ }
    // advisory gap: dictionary features whose vocabulary never appeared in the code
    for (const canon of dictionaryCanonicals(match.domain)) if (!hit.has(canon)) expectedNotFound.push(canon);
  }

  // 5. fold Core leftovers into one "Core" feature per category (never their own features)
  for (const [area, mods] of coreByArea) {
    if (!mods.length) continue;
    const category = match ? uncategorizedLabel(match.domain) : titleCase(area === "(root)" ? "(core)" : area);
    feats.push({
      token: "(core)", label: "Core", category, modules: mods.slice().sort(),
      layers: [], crossLayerSpread: 0, aliases: [], source: "folder-fallback", confidence: "low",
    });
  }

  // 6. merge features that resolved to the same (category, label): distinct tokens that
  //    canonicalize to one dictionary feature (deal + flash sale → Coupon), and the per-area
  //    Core buckets that share a category. One feature per (category, label).
  const SRC_RANK: Record<VocabFeature["source"], number> = { "token+entry": 3, dictionary: 2, token: 1, "folder-fallback": 0 };
  const CONF_RANK: Record<VocabFeature["confidence"], number> = { high: 3, medium: 2, low: 1 };
  const merged = new Map<string, VocabFeature>();
  for (const f of feats) {
    const k = `${f.category} ${f.label}`;
    const prev = merged.get(k);
    if (!prev) { merged.set(k, { ...f, modules: [...f.modules], aliases: [...f.aliases], entryPoints: f.entryPoints ? [...f.entryPoints] : undefined }); continue; }
    prev.modules = [...new Set([...prev.modules, ...f.modules])].sort();
    prev.aliases = [...new Set([...prev.aliases, ...f.aliases, f.token, prev.token].filter((t) => t !== prev.label.toLowerCase()))].sort();
    const ep = [...(prev.entryPoints ?? []), ...(f.entryPoints ?? [])];
    prev.entryPoints = ep.length ? [...new Set(ep)].sort() : undefined;
    prev.layers = [...new Set([...prev.layers, ...f.layers])].sort();
    prev.crossLayerSpread = Math.max(prev.crossLayerSpread, f.crossLayerSpread);
    if (SRC_RANK[f.source] > SRC_RANK[prev.source]) prev.source = f.source;
    if (CONF_RANK[f.confidence] > CONF_RANK[prev.confidence]) prev.confidence = f.confidence;
    prev.canonical ??= f.canonical;
    prev.domain ??= f.domain;
  }
  const outFeats = [...merged.values()];

  // deterministic order
  outFeats.sort((a, b) =>
    (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
    b.modules.length - a.modules.length ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return {
    features: outFeats,
    domain: match?.domain ?? null,
    domainMatched: match?.matched ?? [],
    expectedNotFound,
    excludedTests,
    coreModules: [...coreByArea.values()].reduce((n, m) => n + m.length, 0),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function push(m: Map<string, string[]>, k: string, v: string): void {
  (m.get(k) ?? m.set(k, []).get(k)!).push(v);
}
function dominant(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bn = -1;
  for (const [k, n] of counts) if (n > bn || (n === bn && best !== null && k < best)) { best = k; bn = n; }
  return best;
}
/** Label for the leftover/plumbing bucket in a detected domain (kept generic). */
function uncategorizedLabel(_domain: string): string {
  return "Platform";
}
/** All canonical feature names a domain dictionary defines (advisory gap check). */
function dictionaryCanonicals(domain: string): string[] {
  // Re-derive from canonicalFeature by probing is not possible; import lazily-safe set.
  return DOMAIN_CANONICALS.get(domain) ?? [];
}

// Built once from the registry so `expectedNotFound` can list unimplemented features.
import { DOMAINS } from "../domain/index.js";
const DOMAIN_CANONICALS = new Map<string, string[]>(
  DOMAINS.map((d) => [d.domain, [...new Set(d.features.map((f) => f.canonical))]]),
);
