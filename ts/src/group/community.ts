// Community detection (Plan 08, Stage 4) — the structural *validator*, not the seed.
// Single-level Louvain (local moving) on the module graph, edges confidence-weighted so
// AMBIGUOUS/INFERRED coupling counts for less than EXTRACTED. Deterministic (sorted node
// order + stable community renumbering: largest community = 0).
import type { CallGraph, Confidence } from "../graph/model.js";

const CONF_WEIGHT: Record<Confidence, number> = { EXTRACTED: 1, INFERRED: 0.6, AMBIGUOUS: 0.3 };

/** Detect communities on a (module-projected) call graph → moduleId → communityId. */
export function detectCommunities(moduleGraph: CallGraph): Map<string, number> {
  const nodes = moduleGraph.nodes.filter((n) => n.kind === "module").map((n) => n.id);
  const adj = new Map<string, Map<string, number>>();
  for (const n of nodes) adj.set(n, new Map());
  const bump = (a: string, b: string, w: number) => {
    const m = adj.get(a);
    if (m) m.set(b, (m.get(b) ?? 0) + w);
  };
  for (const e of moduleGraph.edges) {
    if (e.kind !== "calls" && e.kind !== "imports") continue;
    if (e.from === e.to || !adj.has(e.from) || !adj.has(e.to)) continue;
    const w = (e.weight ?? 1) * (CONF_WEIGHT[e.confidence] ?? 0.5);
    bump(e.from, e.to, w); // symmetric — undirected modularity
    bump(e.to, e.from, w);
  }

  const degree = new Map<string, number>();
  let m2 = 0;
  for (const [n, nbrs] of adj) {
    let d = 0;
    for (const w of nbrs.values()) d += w;
    degree.set(n, d);
    m2 += d;
  }
  if (m2 === 0) return renumber(new Map(nodes.map((n, i) => [n, i])), nodes); // no edges → each alone

  const comm = new Map<string, number>();
  const commTot = new Map<number, number>();
  nodes.forEach((n, i) => {
    comm.set(n, i);
    commTot.set(i, degree.get(n) ?? 0);
  });

  const sorted = [...nodes].sort();
  let improved = true;
  let pass = 0;
  while (improved && pass < 50) {
    improved = false;
    pass++;
    for (const n of sorted) {
      const ki = degree.get(n) ?? 0;
      const ci = comm.get(n)!;
      commTot.set(ci, (commTot.get(ci) ?? 0) - ki);

      const wTo = new Map<number, number>();
      for (const [nb, w] of adj.get(n)!) {
        const cj = comm.get(nb)!;
        wTo.set(cj, (wTo.get(cj) ?? 0) + w);
      }
      let best = ci;
      let bestGain = (wTo.get(ci) ?? 0) - ((commTot.get(ci) ?? 0) * ki) / m2;
      for (const [cj, win] of wTo) {
        const gain = win - ((commTot.get(cj) ?? 0) * ki) / m2;
        if (gain > bestGain + 1e-12) { bestGain = gain; best = cj; }
      }
      comm.set(n, best);
      commTot.set(best, (commTot.get(best) ?? 0) + ki);
      if (best !== ci) improved = true;
    }
  }
  return renumber(comm, nodes);
}

// Stable ids: communities sorted by size desc, then smallest member id → 0,1,2,…
function renumber(comm: Map<string, number>, nodes: string[]): Map<string, number> {
  const members = new Map<number, string[]>();
  for (const n of nodes) {
    const c = comm.get(n)!;
    (members.get(c) ?? members.set(c, []).get(c)!).push(n);
  }
  const order = [...members.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[1].slice().sort()[0] < b[1].slice().sort()[0] ? -1 : 1),
  );
  const remap = new Map<number, number>();
  order.forEach(([oldId], i) => remap.set(oldId, i));
  const out = new Map<string, number>();
  for (const n of nodes) out.set(n, remap.get(comm.get(n)!)!);
  return out;
}
