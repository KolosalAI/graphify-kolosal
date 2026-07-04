// Call-graph smoke test (Plan 04). Parses small multi-file corpora via the real loader,
// serializes ASTs, runs generateCallGraph, and asserts the resolved edges. Also checks
// generateCallGraph works on a hand-written AST with no parser. Run: npm run graph-smoke
import { getParser } from "../grammar/loader.js";
import { serializeAst } from "../parse/ast.js";
import { generateCallGraph, projectToModules, rankGodNodes, findDeadCode, type FileAst } from "./index.js";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

async function astOf(relPath: string, key: string, source: string): Promise<FileAst> {
  const parser = await getParser(key);
  const tree = parser.parse(source)!;
  const root = serializeAst(tree.rootNode, { includeText: false });
  tree.delete();
  parser.delete();
  return { relPath, key, root, source };
}

const hasEdge = (g: any, fromQ: string, toQ: string, kind: string) => {
  const id = (q: string) => g.nodes.find((n: any) => n.qualifiedName === q)?.id;
  const f = id(fromQ), t = id(toQ);
  return g.edges.some((e: any) => e.from === f && e.to === t && e.kind === kind);
};

async function main() {
  // 1. Python: intra-file call + top-level call attributed to module + passes.
  const py = generateCallGraph([
    await astOf("util.py", "python",
      "def format(x):\n    return x\n\ndef greet(name):\n    return format(name)\n\ngreet('hi')\nrun(greet)\n"),
  ]);
  check("py greet→format (calls)", hasEdge(py, "util.greet", "util.format", "calls"));
  check("py module→greet (calls, top-level)", hasEdge(py, "util", "util.greet", "calls"));
  check("py module passes greet into run(greet)", hasEdge(py, "util", "util.greet", "passes"));
  check("py run unresolved", py.unresolved.some((u: any) => u.callee === "run"));
  check("py builtin not a node", !py.nodes.some((n: any) => n.name === "print"));

  // 2. Cross-file (Python import): a.py imports and calls b.py's helper.
  const cross = generateCallGraph([
    await astOf("b.py", "python", "def helper():\n    return 1\n"),
    await astOf("a.py", "python", "from b import helper\n\ndef run():\n    return helper()\n"),
  ]);
  check("cross a.run→b.helper (EXTRACTED via import)",
    cross.edges.some((e: any) => e.kind === "calls" && cross.nodes.find((n: any) => n.id === e.from)?.qualifiedName === "a.run" && cross.nodes.find((n: any) => n.id === e.to)?.qualifiedName === "b.helper"));
  check("cross a imports b (module edge)", hasEdge(cross, "a", "b", "imports"));

  // 3. TS: OOP method + const-arrow function + higher-order passes.
  const ts = generateCallGraph([
    await astOf("app.ts", "typescript",
      "class Dog {\n  bark() { return 1; }\n}\nconst greet = (n: string) => n;\nfunction run() {\n  const d = new Dog();\n  d.bark();\n  [1].map(greet);\n}\n"),
  ]);
  check("ts class Dog node", ts.nodes.some((n: any) => n.kind === "class" && n.name === "Dog"));
  check("ts method Dog.bark node", ts.nodes.some((n: any) => n.qualifiedName === "Dog.bark" && n.kind === "method"));
  check("ts const-arrow greet is a function node", ts.nodes.some((n: any) => n.qualifiedName === "app.greet" && n.kind === "function"));
  check("ts run→Dog.bark (method dispatch)", hasEdge(ts, "app.run", "Dog.bark", "calls"));
  check("ts run passes greet into map", hasEdge(ts, "app.run", "app.greet", "passes"));

  // 4. Module projection collapses function edges to module→module.
  const mod = projectToModules(cross);
  check("module graph: a→b calls edge", mod.edges.some((e: any) => e.from === "module:a.py" && e.to === "module:b.py" && e.kind === "calls"));
  check("module graph only module nodes", mod.nodes.every((n: any) => n.kind === "module"));

  // 4b. Plan 05: type table promotes method dispatch to EXTRACTED and disambiguates.
  const typed = generateCallGraph([
    await astOf("zoo.py", "python",
      "class Dog:\n    def bark(self):\n        return 1\n\nclass Seal:\n    def bark(self):\n        return 2\n\ndef run():\n    d = Dog()\n    d.bark()\n"),
  ]);
  const edgeConf = (g: any, fromQ: string, toQ: string) => {
    const id = (q: string) => g.nodes.find((n: any) => n.qualifiedName === q)?.id;
    return g.edges.find((e: any) => e.from === id(fromQ) && e.to === id(toQ) && e.kind === "calls")?.confidence;
  };
  check("plan05 d.bark() → Dog.bark EXTRACTED (not Seal)", edgeConf(typed, "zoo.run", "Dog.bark") === "EXTRACTED",
    `conf=${edgeConf(typed, "zoo.run", "Dog.bark")}`);
  check("plan05 no edge to Seal.bark", !hasEdge(typed, "zoo.run", "Seal.bark", "calls"));

  // 4c. Plan 05: self-dispatch and annotated-param dispatch resolve to EXTRACTED.
  const selfg = generateCallGraph([
    await astOf("s.py", "python",
      "class A:\n    def a(self):\n        return self.b()\n    def b(self):\n        return 1\n\ndef use(x: A):\n    x.a()\n"),
  ]);
  check("plan05 self.b() → A.b EXTRACTED", edgeConf(selfg, "A.a", "A.b") === "EXTRACTED", `conf=${edgeConf(selfg, "A.a", "A.b")}`);
  check("plan05 annotated param x:A → A.a EXTRACTED", edgeConf(selfg, "s.use", "A.a") === "EXTRACTED", `conf=${edgeConf(selfg, "s.use", "A.a")}`);

  // 4d. Plan 05: TS instantiation + inheritance dispatch.
  const tsInherit = generateCallGraph([
    await astOf("z.ts", "typescript",
      "class Animal {\n  speak() { return 0; }\n}\nclass Cat extends Animal {\n}\nfunction go() {\n  const c = new Cat();\n  c.speak();\n}\n"),
  ]);
  check("plan05 TS c.speak() inherits Animal.speak EXTRACTED", edgeConf(tsInherit, "z.go", "Animal.speak") === "EXTRACTED",
    `conf=${edgeConf(tsInherit, "z.go", "Animal.speak")}`);

  // 5. generateCallGraph works on a hand-written AST (no parser).
  const handAst: FileAst = {
    relPath: "h.py", key: "python", source: "def a():\n  b()\ndef b():\n  pass\n",
    root: {
      type: "module", named: true, startIndex: 0, endIndex: 30, start: [0, 0], end: [4, 0],
      children: [
        { type: "function_definition", named: true, startIndex: 0, endIndex: 14, start: [0, 0], end: [1, 5], children: [
          { type: "identifier", named: true, field: "name", startIndex: 4, endIndex: 5, start: [0, 4], end: [0, 5], text: "a", children: [] },
          { type: "block", named: true, startIndex: 9, endIndex: 14, start: [1, 2], end: [1, 5], children: [
            { type: "call", named: true, startIndex: 9, endIndex: 12, start: [1, 2], end: [1, 5], children: [
              { type: "identifier", named: true, field: "function", startIndex: 9, endIndex: 10, start: [1, 2], end: [1, 3], text: "b", children: [] },
              { type: "argument_list", named: true, field: "arguments", startIndex: 10, endIndex: 12, start: [1, 3], end: [1, 5], children: [] },
            ] },
          ] },
        ] },
        { type: "function_definition", named: true, startIndex: 15, endIndex: 29, start: [2, 0], end: [3, 6], children: [
          { type: "identifier", named: true, field: "name", startIndex: 19, endIndex: 20, start: [2, 4], end: [2, 5], text: "b", children: [] },
        ] },
      ],
    },
  };
  const hand = generateCallGraph([handAst]);
  check("hand-written AST: a→b resolved", hasEdge(hand, "h.a", "h.b", "calls"));

  // 6. Plan 06: god-node ranking — the widely-called helper ranks first.
  const corpus = generateCallGraph([
    await astOf("lib.py", "python", "def fmt(x):\n    return x\n"),
    await astOf("a.py", "python", "from lib import fmt\n\ndef a():\n    fmt(1)\n"),
    await astOf("b.py", "python", "from lib import fmt\n\ndef b():\n    fmt(2)\n"),
    await astOf("c.py", "python", "from lib import fmt\n\ndef c():\n    fmt(3)\n"),
  ]);
  const gods = rankGodNodes(corpus, { topN: 5 });
  check("god node #1 is lib.fmt", gods[0]?.label === "lib.fmt", `#1=${gods[0]?.label}`);
  check("lib.fmt inDegree 3", gods[0]?.inDegree === 3, `in=${gods[0]?.inDegree}`);
  check("no module node ranked", gods.every((g: any) => g.kind !== "module"));
  check("lib.fmt flagged utility-hub", gods[0]?.utilityHub === true);
  const inRank = rankGodNodes(corpus, { direction: "out", topN: 5 });
  check("direction=out surfaces callers, not fmt", inRank[0]?.label !== "lib.fmt");
  const modRank = rankGodNodes(corpus, { granularity: "module", topN: 5 });
  check("module ranking: lib module ranks by imports", modRank[0]?.label === "lib" && modRank.every((g: any) => g.kind === "module"),
    `#1=${modRank[0]?.label}`);

  // 7. Plan 07: dead-code reachability.
  const dc = generateCallGraph([
    await astOf("m.py", "python",
      "def used():\n    return 1\n\ndef dead():\n    return 2\n\ndef _helper():\n    return dead_chain()\n\ndef dead_chain():\n    return 3\n\ndef register(cb):\n    return cb\n\ndef cb_fn():\n    return 9\n\nused()\nregister(cb_fn)\n"),
  ]);
  const dead = findDeadCode(dc, { mode: "application" });
  const isDead = (label: string) => dead.dead.some((d: any) => d.label === label);
  check("plan07 used() is live (top-level call)", !isDead("m.used"));
  check("plan07 dead() is dead", isDead("m.dead"));
  check("plan07 _helper() dead (never called)", isDead("m._helper"));
  check("plan07 dead_chain() dead (only called by dead _helper)", isDead("m.dead_chain"));
  check("plan07 cb_fn live via passes(register(cb_fn))", !isDead("m.cb_fn"));

  // 7b. Plan 07: library mode keeps public API live; dynamic downgrade.
  const lib = generateCallGraph([
    await astOf("api.py", "python", "def public_api():\n    return 1\n\ndef handler():\n    return 2\n\ngetattr(x, 'handler')()\n"),
  ]);
  const appMode = findDeadCode(lib, { mode: "application" });
  const libMode = findDeadCode(lib, { mode: "library" });
  check("plan07 public_api dead in application mode", appMode.dead.some((d: any) => d.label === "api.public_api"));
  check("plan07 public_api LIVE in library mode", !libMode.dead.some((d: any) => d.label === "api.public_api"));
  const handlerDead = appMode.dead.find((d: any) => d.label === "api.handler");
  check("plan07 handler downgraded to medium (dynamic name collision)", handlerDead?.confidence === "medium",
    `conf=${handlerDead?.confidence} risk=${handlerDead?.dynamicRisk}`);

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
