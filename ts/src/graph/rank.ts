// God-node ranking (Plan 06). Degree centrality over a *semantic* subset of edge kinds
// (calls + passes) with graphify's noise filters mapped to our node model. Runs on a
// finished CallGraph — quality is bounded by Plan 04/05 resolution precision.
import type { CallGraph, Confidence, EdgeKind, NodeKind } from "./model.js";

export interface GodNode {
  id: string;
  label: string; // qualifiedName
  kind: NodeKind;
  file: string;
  degree: number; // in + out over ranked edge kinds
  inDegree: number;
  outDegree: number;
  score: number; // per `direction` (+ weighted)
  utilityHub?: true; // broad fan-in / low fan-out leaf (advisory)
}

export interface GodNodeOptions {
  topN?: number; // default 10
  edgeKinds?: EdgeKind[]; // default ["calls","passes"] (function) / ["calls","imports"] (module)
  direction?: "in" | "out" | "total"; // default "total"
  weighted?: boolean; // default true — sum edge weights
  granularity?: "function" | "module"; // default "function"
  excludeHubPercentile?: number; // drop nodes above this degree percentile (off by default)
  flagUtilityHubs?: boolean; // default true
  minConfidence?: Confidence; // rank only on edges at/above this confidence
}

const CONF_RANK: Record<Confidence, number> = { AMBIGUOUS: 1, INFERRED: 2, EXTRACTED: 3 };

/** Rank the call graph's core abstractions (most-connected real entities). */
export function rankGodNodes(graph: CallGraph, opts: GodNodeOptions = {}): GodNode[] {
  const topN = opts.topN ?? 10;
  const granularity = opts.granularity ?? "function";
  const direction = opts.direction ?? "total";
  const weighted = opts.weighted ?? true;
  const flagUtil = opts.flagUtilityHubs ?? true;
  const minRank = opts.minConfidence ? CONF_RANK[opts.minConfidence] : 0;
  const edgeKinds = new Set<EdgeKind>(
    opts.edgeKinds ?? (granularity === "module" ? ["calls", "imports"] : ["calls", "passes"]),
  );

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inW = new Map<string, number>();
  const outW = new Map<string, number>();
  const inFiles = new Map<string, Set<string>>();

  for (const e of graph.edges) {
    if (!edgeKinds.has(e.kind)) continue; // `contains` excluded → modules/classes not inflated
    if (minRank && CONF_RANK[e.confidence] < minRank) continue;
    const w = weighted ? e.weight ?? 1 : 1;
    outW.set(e.from, (outW.get(e.from) ?? 0) + w);
    inW.set(e.to, (inW.get(e.to) ?? 0) + w);
    const f = byId.get(e.from)?.file;
    if (f) {
      let s = inFiles.get(e.to);
      if (!s) inFiles.set(e.to, (s = new Set()));
      s.add(f);
    }
  }

  // graphify's filters mapped: exclude modules + externals (function granularity); the
  // module ranking flips to module nodes. builtins are already absent (Plan 04).
  const isCandidate = (kind: NodeKind, external?: boolean): boolean => {
    if (external) return false;
    if (granularity === "module") return kind === "module";
    return kind === "function" || kind === "method" || kind === "lambda" || kind === "class";
  };

  let candidates: GodNode[] = [];
  for (const n of graph.nodes) {
    if (!isCandidate(n.kind, n.external)) continue;
    const inDegree = inW.get(n.id) ?? 0;
    const outDegree = outW.get(n.id) ?? 0;
    const degree = inDegree + outDegree;
    const score = direction === "in" ? inDegree : direction === "out" ? outDegree : degree;
    const g: GodNode = { id: n.id, label: n.qualifiedName, kind: n.kind, file: n.file, degree, inDegree, outDegree, score };
    if (flagUtil && (inFiles.get(n.id)?.size ?? 0) >= 3 && inDegree >= 3 && outDegree <= 1) g.utilityHub = true;
    candidates.push(g);
  }

  // Optional super-hub exclusion (mirrors cluster.py exclude_hubs_percentile intent):
  // drop the top-percentile hubs so utility hubs don't crowd out real abstractions.
  if (opts.excludeHubPercentile != null && candidates.length) {
    const degs = candidates.map((c) => c.degree).sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor((degs.length * opts.excludeHubPercentile) / 100) - 1);
    const threshold = degs[idx];
    candidates = candidates.filter((c) => c.degree <= threshold);
  }

  // Deterministic: score desc, tie-break id asc.
  candidates.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates.slice(0, topN);
}
