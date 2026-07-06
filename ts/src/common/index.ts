// Plan 12 — Common (infrastructure) taxonomy + classifier. Parallel to src/domain/: a small,
// extensible set of canonical *common* categories with layer/name/import hints, plus a pure
// classifier that maps a module to a common category (or null = business/domain code).
//
// The governing rule (Plan 12): APIs/persistence/UI-primitives/config/utilities are Common; the
// business *capability* that references them is Business. Layer + filename fingerprint drive this
// with no framework knowledge required.

export type CommonCategory =
  | "API / Endpoints"
  | "Persistence / DB"
  | "Data Models"
  | "Networking / API-Client"
  | "Routing / Middleware"
  | "UI Primitives"
  | "UI Components"
  | "State / Store"
  | "Auth / Session"
  | "Config / Env"
  | "Observability / Logging"
  | "Utilities"
  | "Types / Contracts"
  | "Bootstrap";

export interface CommonHit {
  category: CommonCategory;
  signal: string; // why (for commonSignals / audit)
}

const seg = (s: string) => s.toLowerCase();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// dir segment → common category (infra layers). Domain-named or not, these layers are infra.
const LAYER_COMMON: Record<string, CommonCategory> = {
  routes: "API / Endpoints", route: "API / Endpoints", controllers: "API / Endpoints",
  controller: "API / Endpoints", endpoints: "API / Endpoints", resolvers: "API / Endpoints",
  handlers: "API / Endpoints",
  repositories: "Persistence / DB", repository: "Persistence / DB", repos: "Persistence / DB",
  dao: "Persistence / DB", db: "Persistence / DB", database: "Persistence / DB",
  persistence: "Persistence / DB", migrations: "Persistence / DB",
  models: "Data Models", model: "Data Models", entities: "Data Models", entity: "Data Models",
  schema: "Data Models", schemas: "Data Models",
  middleware: "Routing / Middleware", middlewares: "Routing / Middleware",
  guards: "Routing / Middleware", interceptors: "Routing / Middleware", filters: "Routing / Middleware",
  atoms: "UI Primitives",
  molecules: "UI Components", organisms: "UI Components", templates: "UI Components",
  "design-system": "UI Components",
  store: "State / Store", stores: "State / Store", reducers: "State / Store", slices: "State / Store",
  config: "Config / Env", constants: "Config / Env", settings: "Config / Env", env: "Config / Env",
  utils: "Utilities", util: "Utilities", helpers: "Utilities", helper: "Utilities", lib: "Utilities",
  types: "Types / Contracts", interfaces: "Types / Contracts", contracts: "Types / Contracts",
};

// filename-stem fingerprints (checked when the layer is ambiguous, e.g. a client `services/` dir
// that mixes a networking client with domain services).
const NAME_COMMON: Array<{ re: RegExp; category: CommonCategory; signal: string }> = [
  { re: /^(api|http)client$|^httpclient$|^apiclient$|(^|.)(axios|fetchclient)$/, category: "Networking / API-Client", signal: "api-client-name" },
  { re: /^(logger|log|logging|telemetry|metrics|tracer|tracing|sentry)$/, category: "Observability / Logging", signal: "observability-name" },
  { re: /(^|.)(middleware|interceptor|guard)$/, category: "Routing / Middleware", signal: "middleware-name" },
  { re: /^(config|constants|settings|env|environment)$/, category: "Config / Env", signal: "config-name" },
  { re: /^(app|main|server|bootstrap|setup|entry|wiring|container)$/, category: "Bootstrap", signal: "bootstrap-name" },
  { re: /^(types|interfaces|contracts|schema|dto)$/, category: "Types / Contracts", signal: "types-name" },
];

/** True for filenames that are pure plumbing regardless of location (barrels, bootstrap). */
export function isBarrelName(stem: string): boolean {
  return stem.toLowerCase() === "index";
}

/**
 * Classify a module path into a common category, or null if it looks like business/domain code.
 * `structural` lets graph/AST callers force a category (e.g. detected barrel / types-only / leaf UI).
 */
export function classifyCommon(
  relPath: string,
  structural?: { barrel?: boolean; typesOnly?: boolean; presentational?: boolean; entity?: boolean },
): CommonHit | null {
  const parts = relPath.split("/");
  const dirs = parts.slice(0, -1).map(seg);
  const stem = norm(parts[parts.length - 1].split(".")[0] ?? "");

  // 1) structural overrides (from AST/graph signals) win — highest precedence.
  //    An accurate barrel (no defs) is plumbing wherever it sits — even inside components/.
  if (structural?.barrel) return { category: "Bootstrap", signal: "ast:barrel" };
  if (structural?.entity) return { category: "Data Models", signal: "ast:entity" };
  if (structural?.typesOnly) return { category: "Types / Contracts", signal: "ast:types-only" };
  if (structural?.presentational) return { category: "UI Primitives", signal: "ast:presentational" };

  // 2) filename fingerprints (before layer, so an apiClient in a services/ dir → Networking).
  for (const n of NAME_COMMON) if (n.re.test(stem)) return { category: n.category, signal: n.signal };

  // 3) infra layer dirs.
  for (const d of dirs) {
    const cat = LAYER_COMMON[d];
    if (cat) return { category: cat, signal: `layer:${d}` };
  }

  // 4) barrels by name, wherever they sit (fallback when no AST signal was supplied).
  if (isBarrelName(stem)) return { category: "Bootstrap", signal: "barrel" };

  return null; // business / domain code
}

// Categories eligible for the ubiquity trim: leaf/cross-cutting utility code (the "logger/env"
// kind). Architectural layers (API, Persistence, Data Models, UI, Bootstrap) are legitimate
// groupings even when heavily used — dissolving them into "Platform Baseline" hurts legibility.
export const UBIQUITY_ELIGIBLE = new Set<CommonCategory>([
  "Utilities", "Config / Env", "Observability / Logging", "Networking / API-Client",
  "Types / Contracts", "State / Store",
]);

/** All common categories, for stable ordering in the output. */
export const COMMON_CATEGORY_ORDER: CommonCategory[] = [
  "API / Endpoints", "Networking / API-Client", "Persistence / DB", "Data Models",
  "UI Components", "UI Primitives", "State / Store", "Auth / Session", "Routing / Middleware",
  "Utilities", "Config / Env", "Observability / Logging", "Types / Contracts", "Bootstrap",
];
