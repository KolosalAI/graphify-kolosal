// Plan 13 — interconnection-based operation splitting. Within a BUSINESS feature (Plan 12), the
// real capabilities are the business-verb-named methods (updateProduct, removeItem, clearCart);
// the page is a mass of anonymous render/lambda UI plumbing, and shared accessors are already in
// the Common tier. We cut connectors (UI/lambda pages, shared callees, betweenness bridges) and
// take the connected components as operation cores — named verb+noun, legibility-gated.
import type { CallGraph, GraphNode } from "../graph/model.js";

// Business verbs that make an operation legible to a product person (verb + noun).
const BUSINESS_VERBS = new Set<string>([
  "get", "fetch", "list", "load", "read", "show", "view", "search", "browse",
  "create", "add", "new", "register", "signup", "insert", "post",
  "update", "edit", "modify", "change", "patch", "set", "rename",
  "delete", "remove", "destroy", "clear", "drop", "cancel", "archive",
  "apply", "place", "submit", "checkout", "purchase", "pay", "confirm", "approve", "reject",
  "sync", "track", "save", "store", "send", "assign", "toggle", "enable", "disable",
  "subscribe", "unsubscribe", "login", "logout", "authenticate", "select", "move", "share",
]);
const words = (name: string): string[] => name.split(/[_\-.]|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
function leadWord(name: string): string {
  return (words(name)[0] ?? name).toLowerCase();
}
const isAnon = (n: GraphNode) => n.kind === "lambda" || /^<|lambda@|anonymous/i.test(n.name);
// A symbol that is a UI component (its name ends in a component role) is never an operation.
const COMPONENT_SUFFIX = /(page|screen|view|component|layout|provider|consumer|context|modal|dialog|popup|drawer|tooltip)$/i;
/** A legible operation entry: named, business-verb *and* a noun (≥2 words), not a component. */
function isOperationEntry(n: GraphNode): boolean {
  if (n.external || isAnon(n)) return false;
  if (n.kind !== "function" && n.kind !== "method") return false;
  const w = words(n.name);
  return w.length >= 2 && BUSINESS_VERBS.has(w[0].toLowerCase()) && !COMPONENT_SUFFIX.test(n.name);
}
const titleCase = (s: string) =>
  s.split(/[_\-.]|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || s;

export interface Operation {
  key: string;
  label: string; // "Update Product"
  verb: string;
  entry: string; // entry symbol id
  entryLabel: string; // qualifiedName
  symbols: string[]; // member symbol ids (entry + private helpers)
  modules: string[]; // hosting relPaths
}
export interface Consumer {
  id: string; // page/component symbol id (or module id)
  label: string;
  kind: "page" | "component" | "route" | "module";
  modules: string[];
  references: string[]; // operation keys it invokes
}
export interface OpAnalysis {
  split: boolean; // ≥2 business ops → split; else keep feature whole
  ops: Operation[];
  consumers: Consumer[];
  connectors: string[]; // shared/bridge symbol ids cut (not their own op)
}

/** Split one business feature's modules into operation cores. `graph` is the whole call graph. */
export function analyzeOperations(featureModules: string[], graph: CallGraph): OpAnalysis {
  const fileSet = new Set(featureModules);
  const syms = graph.nodes.filter((n) => fileSet.has(n.file) && !n.external && (n.kind === "function" || n.kind === "method" || n.kind === "lambda" || n.kind === "class"));
  const symIds = new Set(syms.map((s) => s.id));
  const byId = new Map(syms.map((s) => [s.id, s]));

  // intra-feature call/passes adjacency
  const adj = new Map<string, Set<string>>();
  for (const s of syms) adj.set(s.id, new Set());
  for (const e of graph.edges) {
    if (e.kind !== "calls" && e.kind !== "passes") continue;
    if (symIds.has(e.from) && symIds.has(e.to) && e.from !== e.to) adj.get(e.from)!.add(e.to);
  }

  // operation entries: named business-verb+noun methods (not components / bare verbs)
  const entries = syms.filter(isOperationEntry);

  // reachability from each entry (over intra edges) → assign private helpers; ≥2 reachers = shared
  const reachers = new Map<string, Set<string>>(); // symbol → entry ids that reach it
  for (const e of entries) {
    const seen = new Set<string>([e.id]);
    const stack = [e.id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    for (const s of seen) (reachers.get(s) ?? reachers.set(s, new Set()).get(s)!).add(e.id);
  }

  const entryIds = new Set(entries.map((e) => e.id));
  const connectors: string[] = [];
  for (const [sym, rs] of reachers) if (!entryIds.has(sym) && rs.size >= 2) connectors.push(sym);
  const connectorSet = new Set(connectors);

  // build ops: entry + its exclusively-reached non-entry, non-shared helpers.
  // memberIds keeps node ids (for consumer matching); symbols exposes readable qualifiedNames.
  const symbolToOp = new Map<string, string>(); // node id → op key
  const ops: Operation[] = entries.map((e) => {
    const memberIds = [e.id];
    for (const [sym, rs] of reachers) {
      if (sym === e.id || entryIds.has(sym) || connectorSet.has(sym)) continue;
      if (rs.size === 1 && rs.has(e.id)) memberIds.push(sym);
    }
    const label = titleCase(e.name);
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    for (const id of memberIds) symbolToOp.set(id, key);
    const modules = [...new Set(memberIds.map((m) => byId.get(m)!.file))].sort();
    const names = [...new Set(memberIds.map((m) => byId.get(m)!.qualifiedName))].sort();
    return { key, label, verb: leadWord(e.name), entry: e.id, entryLabel: e.qualifiedName, symbols: names, modules };
  });

  // merge ops that resolved to the same label (verb+noun collision) — one operation
  const byLabel = new Map<string, Operation>();
  for (const op of ops) {
    const prev = byLabel.get(op.label);
    if (!prev) { byLabel.set(op.label, op); continue; }
    prev.symbols = [...new Set([...prev.symbols, ...op.symbols])].sort();
    prev.modules = [...new Set([...prev.modules, ...op.modules])].sort();
    for (const [id, k] of symbolToOp) if (k === op.key) symbolToOp.set(id, prev.key); // remap to survivor
  }
  const mergedOps = [...byLabel.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // consumers: modules whose symbols include NO entry (pure UI/lambda pages) but call an entry
  const consumers: Consumer[] = [];
  for (const mod of featureModules) {
    const modSyms = syms.filter((s) => s.file === mod);
    if (!modSyms.length || modSyms.some((s) => entryIds.has(s.id))) continue; // hosts an op → not a pure consumer
    const refs = new Set<string>();
    for (const s of modSyms) for (const nb of adj.get(s.id) ?? []) { const k = symbolToOp.get(nb); if (k) refs.add(k); }
    if (refs.size) {
      const isPage = /page|screen|view|component|\.jsx$|\.tsx$/i.test(mod);
      consumers.push({ id: `module:${mod}`, label: titleCase(mod.slice(mod.lastIndexOf("/") + 1).split(".")[0]), kind: isPage ? "page" : "module", modules: [mod], references: [...refs].sort() });
    }
  }

  return { split: mergedOps.length >= 2, ops: mergedOps, consumers, connectors: connectors.sort() };
}
