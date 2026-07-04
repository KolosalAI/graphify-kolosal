// Module-level projection (Plan 04): collapse the callable graph to module→module by
// mapping every node to its module and aggregating calls/passes edges (dedup, sum weight).
import type { CallGraph, GraphEdge, GraphNode } from "./model.js";

function baseNoExt(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function projectToModules(g: CallGraph): CallGraph {
  const moduleOf = new Map<string, string>();
  const modNodes = new Map<string, GraphNode>();

  for (const n of g.nodes) {
    const mid = n.kind === "module" ? n.id : n.external ? "module:<external>" : `module:${n.file}`;
    moduleOf.set(n.id, mid);
    if (!modNodes.has(mid)) {
      if (n.kind === "module") modNodes.set(mid, { ...n });
      else
        modNodes.set(mid, {
          id: mid, kind: "module", name: n.external ? "<external>" : n.file,
          qualifiedName: n.external ? "<external>" : baseNoExt(n.file), file: n.external ? "<external>" : n.file,
          key: n.key, startIndex: 0, endIndex: 0, ...(n.external ? { external: true as const } : {}),
        });
    }
  }

  const edgeMap = new Map<string, GraphEdge>();
  const add = (from: string, to: string, kind: GraphEdge["kind"], confidence: GraphEdge["confidence"]) => {
    if (from === to) return; // drop intra-module self-loops
    const k = `${from}|${to}|${kind}`;
    const e = edgeMap.get(k);
    if (e) e.weight = (e.weight ?? 1) + 1;
    else edgeMap.set(k, { from, to, kind, confidence, weight: 1 });
  };

  for (const e of g.edges) {
    if (e.kind === "calls" || e.kind === "passes") {
      const f = moduleOf.get(e.from);
      const t = moduleOf.get(e.to);
      if (f && t) add(f, t, "calls", e.confidence);
    } else if (e.kind === "imports") {
      add(e.from, e.to, "imports", e.confidence);
    }
  }

  const nodes = [...modNodes.values()];
  const edges = [...edgeMap.values()];
  const byEdgeKind: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const e of edges) { byEdgeKind[e.kind] = (byEdgeKind[e.kind] ?? 0) + 1; byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1; }

  return {
    meta: {
      ...g.meta, granularity: "module",
      counts: { nodes: nodes.length, edges: edges.length, byNodeKind: { module: nodes.length }, byEdgeKind, byConfidence, unresolved: g.unresolved.length },
    },
    nodes, edges, unresolved: g.unresolved,
  };
}
