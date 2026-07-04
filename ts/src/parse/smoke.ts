// Parse-stage smoke test (Plan 03). Builds a fixture zip, runs the ingest pipeline
// (Plan 02) then parseEach (Plan 03), and asserts root types, error tolerance,
// serialization (with field names), and the on-disk AST dump. Run: npm run parse-smoke
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { prepareZip } from "../util/prepare.js";
import { parseEach, serializeAst, type ParsedFile } from "./index.js";
import { getParser } from "../grammar/loader.js";

const EXPECT_ROOT: Record<string, string> = {
  "proj/main.py": "module",
  "proj/app.ts": "program",
  "proj/Component.tsx": "program",
  "proj/lib.go": "source_file",
  "proj/broken.py": "module", // parses with errors, still a module root
};

const zip = zipSync({
  "proj/main.py": strToU8("def f(x):\n    return x + 1\n"),
  "proj/app.ts": strToU8("export function f(x: number): number { return x + 1; }\n"),
  "proj/Component.tsx": strToU8("export const C = () => <div>{f(1)}</div>;\n"),
  "proj/lib.go": strToU8("package main\nfunc f(x int) int { return x + 1 }\n"),
  "proj/broken.py": strToU8("def f(:\n    return\n"), // deliberate syntax error
  "proj/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), // removed by ingest
});

const scratch = mkdtempSync(join(tmpdir(), "graphify-parse-smoke-"));
const zipPath = join(scratch, "fixture.zip");
writeFileSync(zipPath, zip);
const astDir = join(scratch, "ast-out");

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const prepared = prepareZip(zipPath);
try {
  const seen = new Map<string, ParsedFile>();
  let liveTreesDuringVisit = 0;

  const summary = await parseEach(
    prepared,
    (pf) => {
      // tree must be alive inside the visitor
      if (pf.tree) liveTreesDuringVisit++;
      // snapshot metadata (do NOT retain the live tree)
      seen.set(pf.relPath, { ...pf, tree: undefined });
    },
    { emitAst: { dir: astDir, format: "json", serialize: { includeText: false } } },
  );

  console.log("summary:", JSON.stringify(summary), "\n");

  // Root types per language.
  for (const [rel, root] of Object.entries(EXPECT_ROOT)) {
    check(`${rel} -> ${root}`, seen.get(rel)?.rootType === root, `got ${seen.get(rel)?.rootType}`);
  }

  // png was filtered by ingest, never parsed.
  check("logo.png not parsed", !seen.has("proj/logo.png"));

  // clean files ok; broken.py is error-tolerant (status error, errorCount>0, no throw).
  check("main.py ok", seen.get("proj/main.py")?.status === "ok");
  const broken = seen.get("proj/broken.py");
  check("broken.py flagged error", broken?.status === "error" && broken.hasError === true);
  check("broken.py errorCount > 0", (broken?.errorCount ?? 0) > 0, `count=${broken?.errorCount}`);

  // summary tallies (5 code files: 4 ok + 1 error).
  check("summary ok=4 error=1", summary.ok === 4 && summary.error === 1, JSON.stringify(summary));
  check("visitor saw live trees", liveTreesDuringVisit === 5, `n=${liveTreesDuringVisit}`);

  // AST dump on disk + index.json manifest.
  check("index.json written", existsSync(join(astDir, "index.json")));
  check("main.py AST dump written", existsSync(join(astDir, "proj/main.py.ast.json")));
  const index = JSON.parse(readFileSync(join(astDir, "index.json"), "utf8")) as any[];
  check("index has 5 entries", index.length === 5, `len=${index.length}`);
  check("index flags broken.py", index.find((e) => e.relPath === "proj/broken.py")?.errorCount > 0);

  // Serialization captures field names (function_definition has a `name` child).
  const parser = await getParser("python");
  const tree = parser.parse("def greet(x):\n    return x\n")!;
  const ast = serializeAst(tree.rootNode, { includeText: true });
  const fn = ast.children.find((c) => c.type === "function_definition");
  const nameChild = fn?.children.find((c) => c.field === "name");
  check("serializeAst captures field 'name'", nameChild?.text === "greet", `got ${JSON.stringify(nameChild)}`);
  check("serializeAst root is module", ast.type === "module");
  tree.delete();
  parser.delete();

  prepared.dispose();
  check("dispose removes rootDir", !existsSync(prepared.rootDir));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
