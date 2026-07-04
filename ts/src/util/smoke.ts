// Ingest smoke test (Plan 02 definition-of-done). Builds an in-memory zip with mixed
// content — including hostile entries — runs prepareZip, and asserts the tree is pruned
// to code only. Run: npm run ingest-smoke
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { prepareZip, parseableFiles } from "./prepare.js";

// A tiny "binary": leading NUL bytes so the sniffer flags it regardless of extension.
const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02, 0x00]);

const zip = zipSync({
  "proj/main.py": strToU8("print(1)\n"),
  "proj/app.ts": strToU8("export const x: number = 1;\n"),
  "proj/Component.tsx": strToU8("export const C = () => <div/>;\n"),
  "proj/Dockerfile": strToU8("FROM node:20\nRUN echo hi\n"),
  "proj/script": strToU8("#!/usr/bin/env python\nprint(2)\n"), // extensionless shebang
  "proj/mod.jl": strToU8("f(x) = x + 1\n"), // julia: pending grammar → kept, not parseable-now
  "proj/logo.png": fakePng, // binary → removed
  "proj/notes.md": strToU8("# readme\n"), // doc → removed (parse stage)
  "proj/data.csv": strToU8("a,b\n1,2\n"), // data → removed
  "proj/app.min.js": strToU8("var a=1;\n"), // minified → removed
  "proj/package-lock.json": strToU8("{}\n"), // lockfile → removed
  "proj/node_modules/dep/index.js": strToU8("module.exports=1\n"), // excluded dir
  "proj/secret.txt": fakePng, // PNG bytes with .txt ext → removed by binary sniff
  "../evil.py": strToU8("print('escape')\n"), // zip-slip → rejected in extract
});

const scratch = mkdtempSync(join(tmpdir(), "graphify-ingest-smoke-"));
const zipPath = join(scratch, "fixture.zip");
writeFileSync(zipPath, zip);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const prepared = prepareZip(zipPath);
try {
  const keptPaths = new Set(prepared.report.kept.map((r) => r.relPath));
  const removedPaths = new Set(prepared.report.removed.map((r) => r.relPath));
  const skippedReasons = new Map(prepared.report.skipped.map((s) => [s.relPath, s.reason]));

  console.log("kept:", [...keptPaths].sort().join(", "));
  console.log("removed:", [...removedPaths].sort().join(", "));
  console.log("skipped:", [...skippedReasons.entries()].map(([p, r]) => `${p}(${r})`).join(", "));
  console.log("");

  // Kept = parseable source only (built grammar). Includes the shebang script; the
  // pending-grammar julia file is NOT kept — it goes to `unparseable`.
  for (const p of ["proj/main.py", "proj/app.ts", "proj/Component.tsx", "proj/Dockerfile", "proj/script"]) {
    check(`kept ${p}`, keptPaths.has(p));
  }
  check("julia NOT kept", !keptPaths.has("proj/mod.jl"));
  // Removed = not-code.
  for (const p of ["proj/logo.png", "proj/notes.md", "proj/data.csv", "proj/app.min.js", "proj/package-lock.json", "proj/secret.txt"]) {
    check(`removed ${p}`, removedPaths.has(p));
  }
  // node_modules never extracted.
  check("node_modules skipped", skippedReasons.get("proj/node_modules/dep/index.js") === "excluded-dir");
  // zip-slip rejected, nothing written outside root.
  check("zip-slip rejected", skippedReasons.get("../evil.py") === "unsafe-path");
  check("no escape file on disk", !existsSync(join(scratch, "evil.py")) && !existsSync(join(tmpdir(), "evil.py")));

  // binary sniff beats a misleading extension.
  const secret = prepared.report.removed.find((r) => r.relPath === "proj/secret.txt");
  check("secret.txt removed as binary", secret?.reason === "binary", `reason=${secret?.reason}`);

  // pending-grammar code lands in `unparseable`, removed from disk.
  const jl = prepared.report.unparseable.find((r) => r.relPath === "proj/mod.jl");
  check("julia in unparseable bucket", jl?.parseableNow === false, `reason=${jl?.reason}`);
  check("julia file off disk", !existsSync(join(prepared.rootDir, "proj/mod.jl")));
  const parseNow = new Set(parseableFiles(prepared.report).map((r) => r.relPath));
  check("main.py parseable-now", parseNow.has("proj/main.py"));
  check("mod.jl not in parseable-now", !parseNow.has("proj/mod.jl"));

  // THE INVARIANT: every file remaining on disk is parseable-now.
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const abs = join(dir, n);
      return statSync(abs).isDirectory() ? walk(abs) : [abs];
    });
  const onDisk = walk(prepared.rootDir).map((abs) => relative(prepared.rootDir, abs).split(sep).join("/"));
  const keptSet = new Set(prepared.report.kept.map((r) => r.relPath));
  const stragglers = onDisk.filter((p) => !keptSet.has(p));
  check("every leftover file is parseable", stragglers.length === 0, `onDisk=${onDisk.sort().join(",")}`);
  check("all kept are parseableNow", prepared.report.kept.every((r) => r.parseableNow === true));

  // dispose cleans up.
  const root = prepared.rootDir;
  prepared.dispose();
  check("dispose removes rootDir", !existsSync(root));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
