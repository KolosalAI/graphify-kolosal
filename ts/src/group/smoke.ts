// Logical-grouping smoke test (Plan 08, Stages 1–4). Builds call graphs from small
// multi-folder corpora and asserts the category→feature tree, community validation, and
// the category-feature.json projection. Run: npm run group-smoke
import { getParser } from "../grammar/loader.js";
import { serializeAst } from "../parse/ast.js";
import { generateCallGraph, type FileAst } from "../graph/index.js";
import { buildGrouping, toCategoryFeatureSummary, partitionByFolders, createLabeler } from "./index.js";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

async function ast(relPath: string, source: string): Promise<FileAst> {
  const parser = await getParser("python");
  const tree = parser.parse(source)!;
  const root = serializeAst(tree.rootNode, { includeText: false });
  tree.delete();
  parser.delete();
  return { relPath, key: "python", root, source };
}

async function main() {
  // A repo with two domains (auth, billing), auth split into two features (login, token).
  const files: FileAst[] = [
    await ast("app/auth/login/session.py", "def login(u):\n    return token_for(u)\n"),
    await ast("app/auth/login/form.py", "def render_login():\n    return 1\n"),
    await ast("app/auth/token/jwt.py", "def token_for(u):\n    return 'jwt'\n"),
    await ast("app/billing/invoice.py", "def make_invoice(x):\n    return charge(x)\n"),
    await ast("app/billing/charge.py", "def charge(x):\n    return x\n"),
  ];
  const graph = generateCallGraph(files);
  const g = buildGrouping(graph, files.map((f) => f.relPath));

  const allCats = (gg: typeof g) => [...gg.business.categories, ...gg.common.categories];
  const cat = (label: string) => allCats(g).find((c) => c.label === label);
  check("category Auth exists", !!cat("Auth"), allCats(g).map((c) => c.label).join(","));
  check("Auth/Billing are business tier", g.business.categories.length >= 2);
  check("category Billing exists", !!cat("Billing"));
  check("common prefix 'app' stripped (no App category)", !cat("App"));
  const auth = cat("Auth");
  check("Auth has features Login + Token", !!auth?.features.find((f) => f.label === "Login") && !!auth?.features.find((f) => f.label === "Token"),
    auth?.features.map((f) => f.label).join(","));
  check("Auth moduleCount = 3", auth?.moduleCount === 3, `${auth?.moduleCount}`);

  // module refs carry god nodes; feature carries anchors
  const login = auth?.features.find((f) => f.label === "Login");
  check("Login feature has module refs", (login?.modules.length ?? 0) === 2);
  check("modules carry relPath", !!login?.modules[0].relPath);

  // partition is pure/deterministic without a graph
  const raw = partitionByFolders(["src/a/x.py", "src/a/y.py", "src/b/z.py"]);
  check("pure partition: 2 categories (a,b)", raw.length === 2 && raw.every((c) => ["a", "b"].includes(c.label)));

  // summary projection: no modules, counts preserved
  const sum = toCategoryFeatureSummary(g);
  check("summary has no module arrays", !JSON.stringify(sum).includes('"modules"'));
  check("summary is two-tier (business/common)", !!sum.business && !!sum.common);
  const sumAuth = [...sum.business.categories, ...sum.common.categories].find((c) => c.label === "Auth");
  check("summary Auth moduleCount matches full tree", sumAuth?.moduleCount === auth?.moduleCount, `${sumAuth?.moduleCount} vs ${auth?.moduleCount}`);
  check("summary feature has moduleCount not modules", (sumAuth?.features[0] as any)?.modules === undefined && typeof sumAuth?.features[0]?.moduleCount === "number");

  // determinism
  const g2 = buildGrouping(graph, files.map((f) => f.relPath));
  check("deterministic (same JSON twice)", JSON.stringify(g) === JSON.stringify(g2));

  // Plan 09: streaming labeler pub-sub (forced fallback → no network calls)
  process.env.QUICK_LLM_API_KEY = ""; // empty → getLLMConfig returns null → fallback path
  const gs = buildGrouping(graph, files.map((f) => f.relPath));
  const gsCats = [...gs.business.categories, ...gs.common.categories];
  const featureCount = gsCats.flatMap((c) => c.features).length;
  const log: Array<[string, any]> = [];
  const labeler = createLabeler(gs, { concurrency: 3 });
  labeler.on("start", (p) => { log.push(["start", p]); });
  labeler.on("feature", (e) => { log.push(["feature", e]); });
  labeler.on("category", (e) => { log.push(["category", e]); });
  labeler.on("done", (d) => { log.push(["done", d]); });
  const returned = await labeler.run();

  const feats = log.filter((x) => x[0] === "feature");
  const cats = log.filter((x) => x[0] === "category");
  check("one feature event per feature", feats.length === featureCount, `${feats.length} vs ${featureCount}`);
  check("every feature index appears once", new Set(feats.map((x) => x[1].index)).size === featureCount);
  check("fallback: all labeledBy fallback, result null", feats.every((x) => x[1].labeledBy === "fallback" && x[1].result === null));
  check("feature event carries node JSON", feats.every((x) => x[1].node && typeof x[1].node.label === "string"));
  const startIdx = log.findIndex((x) => x[0] === "start");
  const lastFeat = log.map((x) => x[0]).lastIndexOf("feature");
  const firstCat = log.findIndex((x) => x[0] === "category");
  check("order: start → features → categories → done", startIdx === 0 && lastFeat < firstCat && log[log.length - 1][0] === "done");
  check("done returns same grouping (back-compat)", returned === gs && gs.meta.llm === false);
  const doneEvt = log.find((x) => x[0] === "done")![1];
  check("done tallies fallback = features+categories", doneEvt.fallback === featureCount + gsCats.length);

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
