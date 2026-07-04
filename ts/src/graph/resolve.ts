// Pass 2 (Plan 04): resolve FileIR[] -> CallGraph. Builds symbol/alias/import tables,
// resolves each call through the confidence tiers, and emits nodes + edges + unresolved.
import { configFor } from "./config.js";
import { buildTypeResolver } from "./types.js";
import type {
  CallGraph, CallGraphOptions, CallRecord, Confidence, FileIR,
  GraphEdge, GraphNode, NodeKind, UnresolvedCall,
} from "./model.js";

function baseNoExt(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
const CALLABLE: Set<NodeKind> = new Set(["function", "method", "lambda"]);
const DIRECT_TARGET: Set<NodeKind> = new Set(["function", "lambda", "class"]);

export function resolve(irs: FileIR[], opts: CallGraphOptions = {}): CallGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedCall[] = [];
  const callRecords: CallRecord[] = [];
  const externalIds = new Set<string>();

  // ── build nodes + indexes ──────────────────────────────────────────────────
  const byId = new Map<string, GraphNode>();
  const directByFile = new Map<string, Map<string, string[]>>(); // file -> name -> ids (fn/class/lambda)
  const directGlobal = new Map<string, string[]>();
  const methodGlobal = new Map<string, string[]>();
  const callableByFile = new Map<string, Map<string, string[]>>(); // for passes/alias resolution
  const callableGlobal = new Map<string, string[]>();
  const aliasByFile = new Map<string, Map<string, string>>();
  const moduleByStem = new Map<string, string>(); // stem -> relPath
  const importedByFile = new Map<string, Map<string, string>>(); // file -> name -> target relPath

  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  const pushNested = (m: Map<string, Map<string, string[]>>, file: string, k: string, v: string) => {
    let inner = m.get(file);
    if (!inner) m.set(file, (inner = new Map()));
    push(inner, k, v);
  };

  for (const ir of irs) {
    if (!moduleByStem.has(baseNoExt(ir.relPath))) moduleByStem.set(baseNoExt(ir.relPath), ir.relPath);
    const modNode: GraphNode = {
      id: ir.moduleId, kind: "module", name: ir.relPath, qualifiedName: baseNoExt(ir.relPath),
      file: ir.relPath, key: ir.key, startIndex: ir.moduleSpan.startIndex, endIndex: ir.moduleSpan.endIndex,
    };
    nodes.push(modNode);
    byId.set(modNode.id, modNode);

    for (const d of ir.defs) {
      const n: GraphNode = {
        id: d.id, kind: d.kind, name: d.name, qualifiedName: d.qualifiedName, file: ir.relPath,
        key: ir.key, startIndex: d.startIndex, endIndex: d.endIndex, scope: d.scope,
        ...(d.exported ? { exported: true } : {}),
        ...(d.decorators ? { decorators: d.decorators } : {}),
      };
      if (byId.has(n.id)) continue; // dedup (e.g. lambda seen twice)
      nodes.push(n);
      byId.set(n.id, n);
      if (DIRECT_TARGET.has(d.kind)) { pushNested(directByFile, ir.relPath, d.name, d.id); push(directGlobal, d.name, d.id); }
      if (d.kind === "method") push(methodGlobal, d.name, d.id);
      if (CALLABLE.has(d.kind)) { pushNested(callableByFile, ir.relPath, d.name, d.id); push(callableGlobal, d.name, d.id); }
    }
    for (const a of ir.aliases) {
      let inner = aliasByFile.get(ir.relPath);
      if (!inner) aliasByFile.set(ir.relPath, (inner = new Map()));
      inner.set(a.name, a.target);
    }
  }

  // ── edges: contains ────────────────────────────────────────────────────────
  const edgeKeys = new Set<string>();
  const addEdge = (e: GraphEdge) => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (edgeKeys.has(key)) {
      const existing = edges.find((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)!;
      existing.weight = (existing.weight ?? 1) + 1;
      return;
    }
    edgeKeys.add(key);
    edges.push({ weight: 1, ...e });
  };

  for (const ir of irs) {
    for (const d of ir.defs) if (byId.has(d.scope)) addEdge({ from: d.scope, to: d.id, kind: "contains", confidence: "EXTRACTED" });
    // inherits
    for (const h of ir.inherits) {
      const target = uniqueOf(directGlobal.get(h.to)); // classes live in directGlobal
      if (target && byId.get(target)?.kind === "class") addEdge({ from: h.from, to: target, kind: "inherits", confidence: "EXTRACTED" });
    }
    // imports
    for (const imp of ir.imports) {
      const stem = imp.from ? imp.from.slice(imp.from.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") : "";
      const targetRel = stem ? moduleByStem.get(stem) : undefined;
      if (targetRel && targetRel !== ir.relPath) {
        addEdge({ from: ir.moduleId, to: `module:${targetRel}`, kind: "imports", confidence: "EXTRACTED" });
        let inner = importedByFile.get(ir.relPath);
        if (!inner) importedByFile.set(ir.relPath, (inner = new Map()));
        for (const nm of imp.names) inner.set(nm, targetRel);
      }
    }
  }

  // ── Plan 05: receiver type table (built after import map exists) ────────────
  const typeResolver = opts.methodDispatch === "name" ? null : buildTypeResolver(irs, byId, importedByFile, opts);

  // ── resolve calls ──────────────────────────────────────────────────────────
  const resolveAlias = (file: string, name: string): string => {
    const m = aliasByFile.get(file);
    let cur = name;
    for (let i = 0; m && i < 8; i++) {
      const next = m.get(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
  const defInModule = (rel: string, name: string, index: Map<string, Map<string, string[]>>): string | undefined =>
    uniqueOf(index.get(rel)?.get(name));

  for (const ir of irs) {
    const cfg = configFor(ir.key);
    for (const call of ir.calls) {
      const site = call.site;
      const emit = (to: string, confidence: Confidence) =>
        addEdge({ from: call.caller, to, kind: "calls", confidence, form: call.form, site });

      let targets: string[] = [];
      let confidence: Confidence = "EXTRACTED";
      let reason: UnresolvedCall["reason"] | null = null;

      if (call.form === "method" || call.form === "super") {
        // Plan 05: try the type table first (self/super/typed receiver) → EXTRACTED.
        let typed = null as ReturnType<NonNullable<typeof typeResolver>["resolveMember"]> | null;
        if (typeResolver) {
          const callerNode = byId.get(call.caller);
          const enclosingClassId = callerNode?.kind === "method" ? callerNode.scope : undefined;
          if (call.form === "super" && enclosingClassId) {
            typed = typeResolver.resolveSuper(enclosingClassId, call.calleeName);
          } else if (cfg && call.receiver && call.receiver === cfg.selfKeyword && enclosingClassId) {
            typed = typeResolver.resolveInClass(enclosingClassId, call.calleeName);
          } else if (call.receiver) {
            typed = typeResolver.resolveMember(call.caller, call.receiver, call.calleeName);
          }
        }
        if (typed && typed.targets.length) {
          targets = typed.targets; confidence = typed.confidence;
        } else {
          // fallback: Plan 04 name-based method dispatch
          const cands = methodGlobal.get(call.calleeName) ?? [];
          if (cands.length === 1) { targets = cands; confidence = "INFERRED"; }
          else if (cands.length > 1) { targets = cands; confidence = "AMBIGUOUS"; }
          else reason = "no-match";
        }
      } else if (call.form === "dynamic") {
        reason = "dynamic";
      } else {
        // direct / constructor. User-defined targets win over the builtin filter, so a
        // file that defines its own `format`/`filter` still resolves to it.
        const name = resolveAlias(ir.relPath, call.calleeName);
        const local = defInModule(ir.relPath, name, directByFile);
        const importedRel = importedByFile.get(ir.relPath)?.get(name);
        const imported = importedRel ? defInModule(importedRel, name, directByFile) : undefined;
        const global = directGlobal.get(name) ?? [];
        if (local) { targets = [local]; confidence = "EXTRACTED"; }
        else if (imported) { targets = [imported]; confidence = "EXTRACTED"; }
        else if (cfg?.builtins.has(name)) { reason = "builtin"; }
        else if (global.length === 1) { targets = global; confidence = "INFERRED"; }
        else if (global.length > 1) { targets = global; confidence = "AMBIGUOUS"; }
        else reason = "no-match";
      }

      if (targets.length) {
        for (const t of targets) emit(t, confidence);
        if (opts.keepCallRecords) callRecords.push({ caller: call.caller, callee: targets[0], form: call.form, args: call.args, returns: call.returns, site, confidence });
      } else {
        const r = reason ?? "no-match";
        unresolved.push({ caller: call.caller, callee: call.calleeName, form: call.form, reason: r, site });
        if (opts.externalNodes && r === "no-match" && call.calleeName) {
          const extId = `external:${call.calleeName}`;
          if (!externalIds.has(extId)) {
            externalIds.add(extId);
            const en: GraphNode = { id: extId, kind: "function", name: call.calleeName, qualifiedName: call.calleeName, file: "<external>", key: "", startIndex: 0, endIndex: 0, external: true };
            nodes.push(en); byId.set(extId, en);
          }
          emit(extId, "INFERRED");
        }
        if (opts.keepCallRecords) callRecords.push({ caller: call.caller, callee: `external:${call.calleeName}`, form: call.form, args: call.args, returns: call.returns, site, confidence: "AMBIGUOUS" });
      }

      // passes: callable arguments handed into the call
      for (const argName of call.argNames) {
        const resolved = resolveAlias(ir.relPath, argName);
        const local = defInModule(ir.relPath, resolved, callableByFile);
        const global = uniqueOf(callableGlobal.get(resolved));
        const target = local ?? global;
        if (target) addEdge({ from: call.caller, to: target, kind: "passes", confidence: local ? "EXTRACTED" : "INFERRED", site });
      }
      for (const lid of call.lambdaArgIds) if (byId.has(lid)) addEdge({ from: call.caller, to: lid, kind: "passes", confidence: "EXTRACTED", site });
    }
  }

  const languages = [...new Set(irs.map((i) => i.key))].sort();
  const graph: CallGraph = {
    meta: buildMeta(nodes, edges, unresolved, irs.length, languages, opts.granularity ?? "function"),
    nodes, edges, unresolved,
  };
  if (opts.keepCallRecords) graph.calls = callRecords;
  if (opts.index) graph.index = buildIndex(nodes, edges);
  return graph;
}

function uniqueOf(ids: string[] | undefined): string | undefined {
  return ids && ids.length === 1 ? ids[0] : undefined;
}

function buildMeta(nodes: GraphNode[], edges: GraphEdge[], unresolved: UnresolvedCall[], fileCount: number, languages: string[], granularity: "function" | "module" | "both"): CallGraph["meta"] {
  const byNodeKind: Record<string, number> = {};
  const byEdgeKind: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const n of nodes) byNodeKind[n.kind] = (byNodeKind[n.kind] ?? 0) + 1;
  for (const e of edges) { byEdgeKind[e.kind] = (byEdgeKind[e.kind] ?? 0) + 1; byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1; }
  return { granularity, fileCount, languages, counts: { nodes: nodes.length, edges: edges.length, byNodeKind, byEdgeKind, byConfidence, unresolved: unresolved.length } };
}

function buildIndex(nodes: GraphNode[], edges: GraphEdge[]): CallGraph["index"] {
  const byId: Record<string, GraphNode> = {};
  const out: Record<string, number[]> = {};
  const inn: Record<string, number[]> = {};
  for (const n of nodes) byId[n.id] = n;
  edges.forEach((e, i) => { (out[e.from] ??= []).push(i); (inn[e.to] ??= []).push(i); });
  return { byId, out, in: inn };
}
