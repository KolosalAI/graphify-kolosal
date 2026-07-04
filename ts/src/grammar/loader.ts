// Grammar loader — the TS analogue of the Python parse setup in
// python/graphify/extract.py (~line 3049):
//
//   mod      = importlib.import_module(config.ts_module)
//   language = Language(getattr(mod, config.ts_language_fn)())
//   parser   = Parser(language)
//
// Here that becomes: resolve a language key/extension -> .wasm, Language.load it
// (cached), and hand back a Parser. web-tree-sitter is initialized once.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { BY_EXTENSION, BY_KEY, type GrammarEntry } from "./manifest.js";

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "wasm");

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();

/** Initialize the web-tree-sitter runtime exactly once (idempotent, concurrent-safe). */
export function init(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

/** Resolve a grammar entry by language key first, then by file extension. */
export function resolveGrammar(keyOrExt: string): GrammarEntry | undefined {
  const k = keyOrExt.toLowerCase().replace(/^\./, "");
  return BY_KEY.get(k) ?? BY_EXTENSION.get(k);
}

/** Load (and cache) a Language by grammar key. Throws if the grammar has no wasm yet. */
export async function loadLanguage(key: string): Promise<Language> {
  const cached = languageCache.get(key);
  if (cached) return cached;

  const entry = BY_KEY.get(key);
  if (!entry) throw new Error(`unknown grammar key: ${key}`);
  if (!entry.wasm) {
    throw new Error(`grammar "${key}" has no wasm yet (status: ${entry.status}) — build it first`);
  }

  await init();
  // Read bytes ourselves so the wasm path is resolved relative to this module,
  // independent of the process cwd.
  const bytes = await readFile(join(WASM_DIR, entry.wasm));
  const language = await Language.load(bytes);
  languageCache.set(key, language);
  return language;
}

/** Get a Parser configured for the given grammar key. */
export async function getParser(key: string): Promise<Parser> {
  const language = await loadLanguage(key);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * Get a Parser for a file path by its extension. Applies the same .tsx-must-use-tsx
 * discrimination the Python side does — extension mapping lives in the manifest.
 * Returns null if no grammar (or no built wasm) covers the extension.
 */
export async function getParserForFile(path: string): Promise<Parser | null> {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  const entry = BY_EXTENSION.get(ext);
  if (!entry || !entry.wasm) return null;
  return getParser(entry.key);
}
