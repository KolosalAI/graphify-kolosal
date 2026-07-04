// Call-graph data model (Plan 04). The processed CallGraph struct + the per-file IR
// that Pass 1 produces and Pass 2 resolves.
import type { AstNode } from "../parse/ast.js";

export type NodeKind =
  | "module"
  | "function"
  | "method"
  | "constructor"
  | "lambda"
  | "class"
  | "interface"
  | "callable-alias";

export type EdgeKind =
  | "calls"
  | "passes"
  | "binds"
  | "constructs"
  | "contains"
  | "imports"
  | "inherits"
  | "implements";

export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type CallForm =
  | "direct"
  | "method"
  | "static"
  | "constructor"
  | "super"
  | "higher-order"
  | "pipeline"
  | "operator"
  | "message"
  | "dynamic";

export interface Span {
  startIndex: number;
  endIndex: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  file: string;
  key: string;
  startIndex: number;
  endIndex: number;
  scope?: string;
  external?: true;
  exported?: boolean; // Plan 07: export/public — a root in library mode
  decorators?: string[]; // Plan 07: decorator names (framework entry hints)
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  form?: CallForm;
  site?: Span;
  weight?: number;
}

export interface Argument {
  position?: number;
  name?: string;
  kind: "value" | "callable-ref" | "lambda" | "literal" | "spread" | "unknown";
  ref?: string;
  text?: string;
}

export interface ReturnBinding {
  kind: "discarded" | "bound" | "returned" | "chained" | "awaited" | "yielded" | "spread";
  name?: string;
  nextSite?: Span;
}

export interface CallRecord {
  caller: string;
  callee: string; // resolved node id (or "external:<name>")
  form: CallForm;
  args: Argument[];
  returns: ReturnBinding;
  site: Span;
  confidence: Confidence;
}

export interface UnresolvedCall {
  caller: string;
  callee: string;
  form: CallForm;
  reason: "dynamic" | "builtin" | "no-match" | "ambiguous-dropped";
  site: Span;
}

export interface CallGraphMeta {
  granularity: "function" | "module" | "both";
  fileCount: number;
  languages: string[];
  counts: {
    nodes: number;
    edges: number;
    byNodeKind: Record<string, number>;
    byEdgeKind: Record<string, number>;
    byConfidence: Record<string, number>;
    unresolved: number;
  };
}

export interface GraphIndex {
  byId: Record<string, GraphNode>;
  out: Record<string, number[]>;
  in: Record<string, number[]>;
}

export interface CallGraph {
  meta: CallGraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedCall[];
  calls?: CallRecord[];
  index?: GraphIndex;
}

// ── input ────────────────────────────────────────────────────────────────────
export interface FileAst {
  relPath: string;
  key: string;
  root: AstNode;
  source?: string;
}

export interface CallGraphOptions {
  granularity?: "function" | "module" | "both";
  keepCallRecords?: boolean;
  externalNodes?: boolean;
  index?: boolean;
  /** Plan 05: "typed" uses the receiver type table (default), "name" = Plan 04 fallback. */
  methodDispatch?: "typed" | "name";
  /** Plan 05: virtual dispatch — resolve to declared type only, or fan out to overrides. */
  virtualDispatch?: "declared" | "overrides";
}

// ── Plan 05: receiver type table ─────────────────────────────────────────────
export interface TypeBinding {
  name: string; // variable / param / field / self|this
  typeName: string; // declared or inferred type name (e.g. "Dog")
  origin: "annotation" | "instantiation" | "return" | "self" | "param";
  scope: string; // owning callable/class/module node id
}

// ── per-file IR (Pass 1 output) ──────────────────────────────────────────────
export interface DefIR {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  className?: string;
  startIndex: number;
  endIndex: number;
  scope: string; // owning node id (module/class/function)
  exported?: boolean;
  decorators?: string[];
}

export interface CallIR {
  caller: string; // enclosing def id or module id
  calleeName: string; // bare name or method name
  receiver?: string; // for member calls (obj in obj.m())
  form: CallForm;
  argNames: string[]; // identifier arguments (candidate callable-refs -> passes)
  lambdaArgIds: string[]; // inline lambda arguments -> passes
  returns: ReturnBinding;
  args: Argument[];
  site: Span;
}

export interface ImportIR {
  names: string[]; // imported symbol names
  from: string; // source module string (raw)
}

export interface AliasIR {
  name: string; // new name
  target: string; // aliased callable name
  scope: string;
}

export interface FileIR {
  relPath: string;
  key: string;
  moduleId: string;
  moduleSpan: Span;
  defs: DefIR[];
  calls: CallIR[];
  imports: ImportIR[];
  aliases: AliasIR[];
  inherits: Array<{ from: string; to: string }>; // class id -> base name
  typeBindings: TypeBinding[]; // Plan 05
}
