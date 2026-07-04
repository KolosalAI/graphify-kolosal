// Public surface for the call-graph stage (Plan 04).
export { generateCallGraph, buildCallGraph } from "./callgraph.js";
export { extractFileIR } from "./extract.js";
export { resolve } from "./resolve.js";
export { projectToModules } from "./project.js";
export { configFor, hasConfig, type CallGraphConfig } from "./config.js";
export { rankGodNodes, type GodNode, type GodNodeOptions } from "./rank.js";
export { findDeadCode, type DeadCodeReport, type DeadNode, type DeadCodeOptions } from "./deadcode.js";
export type {
  CallGraph, CallGraphMeta, CallGraphOptions, FileAst,
  GraphNode, GraphEdge, NodeKind, EdgeKind, Confidence, CallForm,
  CallRecord, Argument, ReturnBinding, UnresolvedCall, GraphIndex,
} from "./model.js";
