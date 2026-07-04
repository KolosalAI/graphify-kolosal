// Dead-code detection (Plan 07): reachability over the call graph from entry-point roots.
// Dead = a callable def no path from a root can reach (NOT merely in-degree 0). Precision
// first — candidates whose name collides with an unresolved/dynamic call are downgraded.
import { configFor } from "./config.js";
import type { CallGraph, GraphNode, NodeKind } from "./model.js";

export interface DeadNode {
  id: string;
  label: string;
  kind: NodeKind;
  file: string;
  span: { startIndex: number; endIndex: number };
  reason: "unreachable";
  confidence: "high" | "medium";
  dynamicRisk?: string; // colliding unresolved/dynamic name, if any
}

export interface DeadCodeReport {
  mode: "application" | "library";
  roots: number;
  reachable: number;
  totalCallables: number;
  dead: DeadNode[];
  stats: {
    byConfidence: Record<string, number>;
    byKind: Record<string, number>;
    deadSpanChars: number;
  };
}

export interface DeadCodeOptions {
  mode?: "application" | "library"; // default "application"
  /** extra root node ids (e.g. framework entries the config can't see) */
  extraRoots?: string[];
}

const CALLABLE: Set<NodeKind> = new Set(["function", "method", "lambda", "class"]);
const REACH_KINDS = new Set(["calls", "passes", "constructs"]);

export function findDeadCode(graph: CallGraph, opts: DeadCodeOptions = {}): DeadCodeReport {
  const mode = opts.mode ?? "application";
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // adjacency over reachability edge kinds
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!REACH_KINDS.has(e.kind)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  }

  // ── roots ────────────────────────────────────────────────────────────────
  const roots = new Set<string>();
  // module nodes: top-level code executes → seed so top-level callees stay live
  for (const n of graph.nodes) if (n.kind === "module") roots.add(n.id);
  for (const id of opts.extraRoots ?? []) roots.add(id);

  const isEntry = (n: GraphNode): boolean => {
    const cfg = configFor(n.key);
    if (!cfg) return false;
    if (cfg.mainMarkers?.has(n.name)) return true;
    if (cfg.testFilePatterns?.some((re) => re.test(n.file))) return true;
    if (cfg.testFuncPatterns?.some((re) => re.test(n.name))) return true;
    if (n.decorators && cfg.entryDecorators?.some((d) => n.decorators!.some((x) => x.includes(d)))) return true;
    if (mode === "library") {
      if (n.exported) return true;
      if (cfg.publicIsRoot && n.scope && byId.get(n.scope)?.kind === "module" && !n.name.startsWith("_")) return true;
    }
    return false;
  };
  for (const n of graph.nodes) {
    if (n.external || !CALLABLE.has(n.kind)) continue;
    if (isEntry(n)) roots.add(n.id);
  }

  // ── reachability BFS ───────────────────────────────────────────────────────
  const live = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.pop()!;
    if (live.has(id)) continue;
    live.add(id);
    for (const to of out.get(id) ?? []) if (!live.has(to)) queue.push(to);
  }

  // ── unresolved/dynamic collisions (for confidence downgrade) ───────────────
  // Exact bare names (no-match), plus dynamic call-expression texts in which a dead
  // name may appear as a string ("getattr(x, 'handler')" mentions handler).
  const exactNames = new Set<string>();
  const dynamicTexts: string[] = [];
  for (const u of graph.unresolved) {
    if (u.reason === "no-match" || u.reason === "ambiguous-dropped") {
      if (u.callee) exactNames.add(u.callee);
    } else if (u.reason === "dynamic" && u.callee) {
      dynamicTexts.push(u.callee);
    }
  }
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dynamicRiskFor = (name: string): boolean => {
    if (exactNames.has(name)) return true;
    if (!dynamicTexts.length) return false;
    const re = new RegExp(`\\b${escapeRe(name)}\\b`);
    return dynamicTexts.some((t) => re.test(t));
  };

  // ── sweep ──────────────────────────────────────────────────────────────────
  const dead: DeadNode[] = [];
  let totalCallables = 0;
  for (const n of graph.nodes) {
    if (n.external || !CALLABLE.has(n.kind)) continue;
    totalCallables++;
    if (live.has(n.id)) continue;
    const risk = dynamicRiskFor(n.name) ? n.name : undefined;
    dead.push({
      id: n.id,
      label: n.qualifiedName,
      kind: n.kind,
      file: n.file,
      span: { startIndex: n.startIndex, endIndex: n.endIndex },
      reason: "unreachable",
      confidence: risk ? "medium" : "high",
      ...(risk ? { dynamicRisk: risk } : {}),
    });
  }

  dead.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.span.startIndex - b.span.startIndex));

  const byConfidence: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let deadSpanChars = 0;
  for (const d of dead) {
    byConfidence[d.confidence] = (byConfidence[d.confidence] ?? 0) + 1;
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    deadSpanChars += d.span.endIndex - d.span.startIndex;
  }

  const liveCallables = [...live].filter((id) => CALLABLE.has(byId.get(id)?.kind as NodeKind)).length;

  return {
    mode,
    roots: roots.size,
    reachable: liveCallables,
    totalCallables,
    dead,
    stats: { byConfidence, byKind, deadSpanChars },
  };
}
