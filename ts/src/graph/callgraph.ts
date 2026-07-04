// Orchestration (Plan 04). generateCallGraph is THE main function: ASTs in -> graph out.
// buildCallGraph is the pipeline wrapper feeding it from a PreparedTree.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeAst } from "../parse/ast.js";
import { parseEach } from "../parse/parser.js";
import type { PreparedTree } from "../util/prepare.js";
import { extractFileIR } from "./extract.js";
import { resolve } from "./resolve.js";
import { projectToModules } from "./project.js";
import type { CallGraph, CallGraphOptions, FileAst } from "./model.js";

/** THE main function — takes serialized ASTs, returns the resolved call graph. Pure. */
export function generateCallGraph(asts: FileAst[], opts: CallGraphOptions = {}): CallGraph {
  const irs = asts.map(extractFileIR);
  const graph = resolve(irs, opts);
  return opts.granularity === "module" ? projectToModules(graph) : graph;
}

/** Pipeline wrapper: PreparedTree -> parse+serialize each file -> generateCallGraph. */
export async function buildCallGraph(
  prepared: PreparedTree,
  opts: CallGraphOptions & { emitDir?: string } = {},
): Promise<CallGraph> {
  const asts: FileAst[] = [];
  await parseEach(prepared, (pf) => {
    if (!pf.tree) return; // skipped/timeout files contribute nothing
    asts.push({ relPath: pf.relPath, key: pf.key, root: serializeAst(pf.tree.rootNode), source: pf.source });
  });

  const graph = generateCallGraph(asts, opts);

  if (opts.emitDir) {
    mkdirSync(opts.emitDir, { recursive: true });
    writeFileSync(join(opts.emitDir, "callgraph.json"), JSON.stringify(graph, null, 2));
  }
  return graph;
}
