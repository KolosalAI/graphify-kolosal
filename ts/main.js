// graphify-ts entry point — take a file and run the prep + parse pipeline into ASTs.
//
//   npx tsx main.js <path/to/file>          # single source file  -> AST (writes <file>.ast.json)
//   npx tsx main.js <path/to/file> --sexp   # single file, print S-expression instead
//   npx tsx main.js <path/to/archive.zip>   # zip -> extract/filter (Plan 02) -> parse (Plan 03)
//
// Run through tsx (the project ships TypeScript sources): `npx tsx main.js <file>`
// or `npm run main -- <file>`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { prepareZip } from "./src/util/prepare.js";
import { getParser, resolveGrammar } from "./src/grammar/loader.js";
import { serializeAst, toSExpression, errorCount } from "./src/parse/index.js";
import { generateCallGraph, buildCallGraph, rankGodNodes, findDeadCode } from "./src/graph/index.js";
import { buildGrouping, toCategoryFeatureSummary, createLabeler, annotateGodReferences } from "./src/group/index.js";

function usage() {
  console.log("Usage: npx tsx main.js <file|archive.zip> [--sexp]");
  console.log("  <file>       parse one source file -> AST (writes <file>.ast.json)");
  console.log("  <file.zip>   extract + filter + parse a whole archive -> ASTs in ./graphify-ast-out");
  console.log("  --sexp       print the S-expression AST (single-file mode)");
}

function countNodes(node) {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

// elapsed-time formatter: ms under a second, else seconds
function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function printCategory(c) {
  console.log(`  ▸ ${c.label}  (${c.moduleCount} modules${c.godNodes[0] ? `, ~${c.godNodes[0]}` : ""})`);
  for (const f of c.features) {
    const fl = f.flags.length ? `  ⚑ ${f.flags.map((x) => x.kind).join(",")}` : "";
    const links = [f.uses && `uses ${f.uses.length}`, f.dataModels && `models ${f.dataModels.length}`, f.usedBy && `usedBy ${f.usedBy.length}`].filter(Boolean).join(", ");
    console.log(`      • ${f.label}  (${f.modules.length}, cohesion ${f.cohesion}${links ? `, ${links}` : ""})${fl}`);
    if (f.ops?.length) console.log(`          ops: ${f.ops.map((o) => o.label).join(" · ")}`);
  }
}
function printTier(name, tier) {
  console.log(`\n══ ${name} ══`);
  for (const c of tier.categories) printCategory(c);
}

async function runFile(path, opts) {
  const ext = extname(path).slice(1).toLowerCase();
  const entry = resolveGrammar(ext) || resolveGrammar(basename(path));
  if (!entry) {
    console.error(`No grammar covers ".${ext}" — not a parseable code file.`);
    process.exit(2);
  }
  if (!entry.wasm) {
    console.error(`Grammar "${entry.key}" is pending (wasm not built yet).`);
    process.exit(3);
  }

  const source = readFileSync(path, "utf8");
  const parser = await getParser(entry.key);
  const tree = parser.parse(source);
  if (!tree) {
    console.error("Parse failed.");
    process.exit(4);
  }
  const root = tree.rootNode;
  const errors = errorCount(root);

  console.log(`file:    ${path}`);
  console.log(`grammar: ${entry.key}`);
  console.log(`root:    ${root.type}`);
  console.log(`errors:  ${errors}${errors ? "  (partial parse)" : ""}`);

  if (opts.sexp) {
    console.log("\n" + toSExpression(root));
    tree.delete();
    parser.delete();
    return;
  }

  const ast = serializeAst(root, { includeText: false });
  const astFile = `${path}.ast.json`;
  writeFileSync(astFile, JSON.stringify(ast, null, 2));
  console.log(`nodes:   ${countNodes(ast)}`);
  console.log(`AST ->   ${astFile}`);

  // Call graph for this single file (intra-file resolution only).
  const graph = generateCallGraph(
    [{ relPath: basename(path), key: entry.key, root: serializeAst(root, { includeText: false }), source }],
    { keepCallRecords: true },
  );
  const cgFile = `${path}.callgraph.json`;
  writeFileSync(cgFile, JSON.stringify(graph, null, 2));
  console.log(
    `graph:   ${graph.meta.counts.nodes} nodes, ${graph.meta.counts.edges} edges, ` +
      `${graph.meta.counts.unresolved} unresolved`,
  );
  console.log(`  edges: ${JSON.stringify(graph.meta.counts.byEdgeKind)}`);
  console.log(`graph -> ${cgFile}`);

  tree.delete();
  parser.delete();
}

async function runZip(path) {
  const outDir = resolve("graphify-out");
  const t0 = performance.now();
  const prepared = prepareZip(path);
  const tExtract = performance.now();
  try {
    const { kept, unparseable, removed, skipped } = prepared.report;
    console.log(`extracted -> ${prepared.rootDir}`);
    console.log(
      `ingest:   kept ${kept.length}, unparseable ${unparseable.length}, ` +
        `removed ${removed.length}, skipped ${skipped.length}\n`,
    );

    // Parse (Plan 03) + build the call graph (Plan 04) in one pass, serialize to JSON.
    const graph = await buildCallGraph(prepared, { keepCallRecords: true, emitDir: outDir });
    const tGraph = performance.now();
    const c = graph.meta.counts;

    console.log(`graph:    ${c.nodes} nodes, ${c.edges} edges, ${c.unresolved} unresolved`);
    console.log(`  nodes:  ${JSON.stringify(c.byNodeKind)}`);
    console.log(`  edges:  ${JSON.stringify(c.byEdgeKind)}`);
    console.log(`  conf:   ${JSON.stringify(c.byConfidence)}`);

    // a few resolved call edges, for a quick eyeball
    const label = (id) => graph.nodes.find((n) => n.id === id)?.qualifiedName ?? id;
    const calls = graph.edges.filter((e) => e.kind === "calls").slice(0, 12);
    if (calls.length) {
      console.log("\nsample calls:");
      for (const e of calls) console.log(`  ${label(e.from)} → ${label(e.to)}  [${e.form}, ${e.confidence}]`);
    }

    // God-node ranking (Plan 06): the core abstractions, by semantic degree.
    const gods = rankGodNodes(graph, { topN: 10 });
    writeFileSync(join(outDir, "godnodes.json"), JSON.stringify(gods, null, 2));
    if (gods.length) {
      console.log("\ngod nodes (degree = calls+passes, in+out):");
      for (const g of gods) {
        const util = g.utilityHub ? "  ⚙ utility-hub" : "";
        console.log(`  ${String(g.score).padStart(3)}  ${g.label}  (${g.kind}, in ${g.inDegree}/out ${g.outDegree})${util}`);
      }
    }

    // Dead code (Plan 07): unreachable defs from entry-point roots.
    const mode = process.argv.slice(3).includes("--library") ? "library" : "application";
    const dead = findDeadCode(graph, { mode });
    writeFileSync(join(outDir, "deadcode.json"), JSON.stringify(dead, null, 2));
    console.log(
      `\ndead code (${dead.mode}): ${dead.dead.length} of ${dead.totalCallables} callables ` +
        `unreachable  ${JSON.stringify(dead.stats.byConfidence)}`,
    );
    for (const d of dead.dead.slice(0, 12)) {
      const risk = d.dynamicRisk ? `  ⚠ dynamic:${d.dynamicRisk}` : "";
      console.log(`  ${d.confidence.padEnd(6)} ${d.label}  (${d.kind}, ${d.file})${risk}`);
    }

    // Logical grouping (Plan 08): category → feature → module tree.
    const moduleFiles = graph.nodes.filter((n) => n.kind === "module").map((n) => n.file);
    const grouping = buildGrouping(graph, moduleFiles);
    // Plan 12: flag god nodes as reference (infra/shared) vs business, then re-write godnodes.json.
    annotateGodReferences(gods, graph, grouping);
    writeFileSync(join(outDir, "godnodes.json"), JSON.stringify(gods, null, 2));
    const tAnalyze = performance.now();

    // Stage 5 (Plan 09): main SUBSCRIBES to the streaming labeler and PUBLISHES the JSON
    // artifacts as each feature/category is labeled — files stay current throughout.
    const publish = () => {
      writeFileSync(join(outDir, "grouping.json"), JSON.stringify(grouping, null, 2));
      writeFileSync(join(outDir, "category-feature.json"), JSON.stringify(toCategoryFeatureSummary(grouping), null, 2));
    };
    console.log(
      `\nlogical grouping: ${grouping.meta.categoryCount} categories, ` +
        `${grouping.meta.featureCount} features (${grouping.meta.businessFeatureCount} business / ` +
        `${grouping.meta.commonFeatureCount} common), ${grouping.meta.flags} flags (${grouping.meta.featureMode ?? "folder"})`,
    );
    if (grouping.meta.domain) {
      console.log(
        `  domain:  ${grouping.meta.domain}  (${grouping.meta.domainMatched?.length ?? 0} canonical features` +
          `${grouping.meta.expectedNotFound?.length ? `, ${grouping.meta.expectedNotFound.length} expected-not-found` : ""})`,
      );
    }
    if (grouping.meta.excludedTests) console.log(`  tests:   ${grouping.meta.excludedTests} excluded from features`);
    if (grouping.meta.ubiquitous?.length) console.log(`  ubiquity: ${grouping.meta.ubiquitous.length} trimmed (T=${grouping.meta.ubiquityThreshold}): ${grouping.meta.ubiquitous.slice(0, 6).join(", ")}${grouping.meta.ubiquitous.length > 6 ? " …" : ""}`);
    if (grouping.meta.operationCount) console.log(`  ops:     ${grouping.meta.operationCount} business operations across ${grouping.meta.consumers?.length ?? 0} consumers`);
    if (process.argv.slice(3).includes("--no-llm")) {
      publish(); // deterministic labels, single write
      printTier("BUSINESS", grouping.business);
      printTier("COMMON", grouping.common);
    } else {
      const labeler = createLabeler(grouping, { concurrency: 3 });
      labeler.on("start", (s) => {
        if (!s.configured) console.log(`⚠ ${s.configError} — using deterministic fallback labels`);
        else console.log(`labeling ${s.featureTotal} features via LLM (concurrency 3)…`);
      });
      labeler.on("feature", (e) => {
        console.log(`  ✓ ${e.node.label}  (${e.labeledBy}, ${fmtMs(e.ms)}${e.fromCache ? ", cached" : ""})`);
        publish(); // ← publish JSON as it goes
      });
      labeler.on("category", (e) => { console.log(`  ▸ ${e.node.label}`); publish(); });
      // Surface the real failure (HTTP 401 bad key, HTTP 400 bad model, timeout, unparseable
      // response…) so the LLM can be debugged, instead of a generic "failed".
      labeler.on("error", (e) => console.log(`  ! LLM error [${e.level} "${e.node.label}"]: ${e.error}  → fallback`));
      labeler.on("done", (d) => { publish(); console.log(`labeled ${d.labeled}, fallback ${d.fallback}${grouping.meta.llm ? ` (${grouping.meta.model})` : ""}`); });
      await labeler.run();
    }
    const tLabel = performance.now();

    console.log(`\ncall graph -> ${outDir}/callgraph.json`);
    console.log(`god nodes  -> ${outDir}/godnodes.json`);
    console.log(`dead code  -> ${outDir}/deadcode.json`);
    console.log(`grouping   -> ${outDir}/grouping.json  (+ category-feature.json)`);

    console.log(
      `\ntiming: extract ${fmtMs(tExtract - t0)} · parse+graph ${fmtMs(tGraph - tExtract)} · ` +
        `analyze+group ${fmtMs(tAnalyze - tGraph)} · llm ${fmtMs(tLabel - tAnalyze)}`,
    );
  } finally {
    prepared.dispose();
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") {
    usage();
    process.exit(arg ? 0 : 1);
  }
  const path = resolve(arg);
  if (!existsSync(path)) {
    console.error(`Not found: ${path}`);
    process.exit(1);
  }
  const sexp = process.argv.slice(3).includes("--sexp");

  const started = performance.now();
  if (path.toLowerCase().endsWith(".zip")) {
    await runZip(path);
  } else {
    await runFile(path, { sexp });
  }
  console.log(`\n⏱  total: ${fmtMs(performance.now() - started)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
