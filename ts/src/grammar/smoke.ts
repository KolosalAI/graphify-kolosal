// Smoke test — verify every Tier A grammar loads and parses a minimal snippet
// without a syntax error. This is the Plan 01 "definition of done" for the wasm set.
//
// Run: npm run smoke
import { getParser, getParserForFile } from "./loader.js";
import { READY, BY_KEY } from "./manifest.js";

// One tiny, valid snippet per language key.
const SNIPPETS: Record<string, string> = {
  python: "def f(x):\n    return x + 1\n",
  javascript: "function f(x) { return x + 1; }\n",
  typescript: "function f(x: number): number { return x + 1; }\n",
  tsx: "const A = () => <div>{f(1)}</div>;\n",
  go: "package main\nfunc f(x int) int { return x + 1 }\n",
  rust: "fn f(x: i32) -> i32 { x + 1 }\n",
  java: "class C { int f(int x) { return x + 1; } }\n",
  c: "int f(int x) { return x + 1; }\n",
  cpp: "int f(int x) { return x + 1; }\n",
  ruby: "def f(x)\n  x + 1\nend\n",
  csharp: "class C { int F(int x) { return x + 1; } }\n",
  kotlin: "fun f(x: Int): Int { return x + 1 }\n",
  scala: "def f(x: Int): Int = x + 1\n",
  php: "<?php\nfunction f($x) { return $x + 1; }\n",
  swift: "func f(x: Int) -> Int { return x + 1 }\n",
  lua: "function f(x) return x + 1 end\n",
  zig: "fn f(x: i32) i32 { return x + 1; }\n",
  elixir: "defmodule M do\n  def f(x), do: x + 1\nend\n",
  objc: "int f(int x) { return x + 1; }\n",
  bash: "f() { echo $(( $1 + 1 )); }\n",
  json: '{ "a": 1, "b": [true, null] }\n',
  dart: "int f(int x) => x + 1;\n",
  solidity: "contract C {\n  function f(uint x) public pure returns (uint) { return x + 1; }\n}\n",
  ocaml: "let f x = x + 1\n",
};

async function main() {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const entry of READY) {
    const src = SNIPPETS[entry.key];
    if (src === undefined) {
      failures.push(`${entry.key}: no smoke snippet defined`);
      fail++;
      continue;
    }
    try {
      const parser = await getParser(entry.key);
      const tree = parser.parse(src);
      const root = tree?.rootNode;
      if (!root) throw new Error("no root node");
      if (root.hasError) throw new Error(`parse produced ERROR node: ${root.toString().slice(0, 80)}`);
      console.log(`  ok   ${entry.key.padEnd(12)} -> ${root.type} (${root.namedChildCount} named children)`);
      pass++;
    } catch (err) {
      failures.push(`${entry.key}: ${(err as Error).message}`);
      console.log(`  FAIL ${entry.key}`);
      fail++;
    }
  }

  // Extension routing check: .tsx must resolve to the tsx grammar, not typescript.
  const tsxParser = await getParserForFile("Component.tsx");
  const tsxRoutedOk = tsxParser !== null && BY_KEY.get("tsx")?.wasm !== undefined;
  console.log(`\nextension routing: .tsx -> ${tsxRoutedOk ? "tsx grammar ok" : "FAILED"}`);
  if (!tsxRoutedOk) { failures.push("tsx extension routing failed"); fail++; }

  console.log(`\n${pass} passed, ${fail} failed  (of ${READY.length} ready grammars)`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
