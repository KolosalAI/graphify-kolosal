// Per-language call-graph config (Plan 04) — the paradigm-aware descriptor that drives
// Pass 1 extraction. Seeded from the Python/JS/TS shapes in graphify's extract.py.
// A language with no config still yields module + (skipped) nodes via graceful degradation.

export interface CallGraphConfig {
  functionTypes: Set<string>;
  methodTypes: Set<string>;
  lambdaTypes: Set<string>;
  classTypes: Set<string>;
  interfaceTypes: Set<string>;
  callTypes: Set<string>;
  constructorCallTypes: Set<string>;
  callCalleeField: string;
  argsField: string;
  accessorTypes: Set<string>;
  accessorNameField: string;
  accessorObjectField: string;
  nameField: string;
  boundaryTypes: Set<string>;
  importTypes: Set<string>;
  /** node types whose value child may bind a callable to a name (const g = () => …) */
  aliasDeclTypes: Set<string>;
  /** builtins to keep out of the def-node set (recorded as unresolved:builtin) */
  builtins: Set<string>;
  superKeyword: string;
  // ── Plan 05: receiver type table hooks (optional; absent → name-based dispatch) ──
  selfKeyword?: string; // "self" (py) / "this" (js/ts) — binds to enclosing class
  typedParamTypes?: Set<string>; // typed_parameter / required_parameter …
  typeBindingDeclTypes?: Set<string>; // assignments/declarators that may carry a type or `new`
  fieldDeclTypes?: Set<string>; // class field/property declarations with a type
  newExprTypeField?: string; // constructor node's type field ("constructor")
  // ── Plan 07: dead-code entry-point hooks ──────────────────────────────────────
  exportMarkers?: Set<string>; // node types that mark a def as exported (parent)
  mainMarkers?: Set<string>; // function names that are runtime entry points (Go main)
  testFilePatterns?: RegExp[]; // relPath patterns for test files (roots)
  testFuncPatterns?: RegExp[]; // def-name patterns for test functions
  entryDecorators?: string[]; // decorator substrings that mark framework entry points
  publicIsRoot?: boolean; // library mode: module-scope non-"_" defs are public roots
}

const s = (...xs: string[]) => new Set(xs);

const PYTHON: CallGraphConfig = {
  functionTypes: s("function_definition"),
  methodTypes: s(), // python methods are function_definition inside a class body
  lambdaTypes: s("lambda"),
  classTypes: s("class_definition"),
  interfaceTypes: s(),
  callTypes: s("call"),
  constructorCallTypes: s(), // Python constructs via a plain call to the class name
  callCalleeField: "function",
  argsField: "arguments",
  accessorTypes: s("attribute"),
  accessorNameField: "attribute",
  accessorObjectField: "object",
  nameField: "name",
  boundaryTypes: s("function_definition", "lambda"),
  importTypes: s("import_statement", "import_from_statement"),
  aliasDeclTypes: s("assignment"),
  builtins: s(
    "print", "len", "range", "int", "str", "float", "bool", "list", "dict", "set",
    "tuple", "type", "isinstance", "super", "open", "enumerate", "zip", "map", "filter",
    "sorted", "sum", "min", "max", "abs", "any", "all", "repr", "format", "getattr",
    "setattr", "hasattr", "id", "input", "iter", "next", "reversed", "round",
  ),
  superKeyword: "super",
  selfKeyword: "self",
  typedParamTypes: s("typed_parameter", "typed_default_parameter"),
  typeBindingDeclTypes: s("assignment"),
  fieldDeclTypes: s(),
  exportMarkers: s(), // python has no export keyword; publicIsRoot covers library mode
  mainMarkers: s(),
  testFilePatterns: [/(^|\/)test_[^/]*\.py$/, /_test\.py$/, /(^|\/)tests?\//],
  testFuncPatterns: [/^test_/],
  entryDecorators: ["route", "get", "post", "put", "delete", "patch", "command", "cli", "fixture", "task", "handler", "on_", "subscribe", "app."],
  publicIsRoot: true,
};

const JS: CallGraphConfig = {
  functionTypes: s("function_declaration", "generator_function_declaration"),
  methodTypes: s("method_definition"),
  lambdaTypes: s("arrow_function", "function_expression", "generator_function"),
  classTypes: s("class_declaration"),
  interfaceTypes: s("interface_declaration"),
  callTypes: s("call_expression", "new_expression"),
  constructorCallTypes: s("new_expression"),
  callCalleeField: "function",
  argsField: "arguments",
  accessorTypes: s("member_expression"),
  accessorNameField: "property",
  accessorObjectField: "object",
  nameField: "name",
  // NB: bare "class" is the keyword token type in tree-sitter — do not include it or it
  // matches the `class` keyword and mints an anonymous class node.
  boundaryTypes: s(
    "function_declaration", "generator_function_declaration", "method_definition",
    "arrow_function", "function_expression", "generator_function",
  ),
  importTypes: s("import_statement"),
  aliasDeclTypes: s("variable_declarator"),
  builtins: s(
    "console", "require", "parseInt", "parseFloat", "isNaN", "isFinite", "String",
    "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Promise", "Symbol",
    "Map", "Set", "RegExp", "Error", "fetch", "setTimeout", "setInterval", "alert",
  ),
  superKeyword: "super",
  selfKeyword: "this",
  typedParamTypes: s("required_parameter", "optional_parameter"),
  typeBindingDeclTypes: s("variable_declarator", "public_field_definition"),
  fieldDeclTypes: s("public_field_definition"),
  newExprTypeField: "constructor",
  exportMarkers: s("export_statement"),
  mainMarkers: s(),
  testFilePatterns: [/\.(test|spec)\.[jt]sx?$/, /(^|\/)__tests__\//],
  testFuncPatterns: [],
  entryDecorators: ["Component", "Controller", "Injectable", "Module", "Get", "Post", "Put", "Delete"],
  publicIsRoot: false,
};

// TS/TSX share the JS shape, plus a couple of TS-only definition types.
const TS: CallGraphConfig = {
  ...JS,
  functionTypes: s("function_declaration", "generator_function_declaration"),
  classTypes: s("class_declaration", "abstract_class_declaration"),
  interfaceTypes: s("interface_declaration"),
};

const GO: CallGraphConfig = {
  functionTypes: s("function_declaration"),
  methodTypes: s("method_declaration"),
  lambdaTypes: s("func_literal"),
  classTypes: s("type_declaration"), // structs/interfaces declared here (coarse)
  interfaceTypes: s(),
  callTypes: s("call_expression"),
  constructorCallTypes: s(),
  callCalleeField: "function",
  argsField: "arguments",
  accessorTypes: s("selector_expression"),
  accessorNameField: "field",
  accessorObjectField: "operand",
  nameField: "name",
  boundaryTypes: s("function_declaration", "method_declaration", "func_literal"),
  importTypes: s("import_declaration"),
  aliasDeclTypes: s(),
  builtins: s(
    "make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover",
    "print", "println", "close", "complex", "real", "imag",
  ),
  superKeyword: "",
  mainMarkers: s("main", "init"), // Go: runtime-invoked entry points
  testFilePatterns: [/_test\.go$/],
  testFuncPatterns: [/^Test/, /^Benchmark/, /^Example/],
  publicIsRoot: true, // exported (Capitalized) Go identifiers; approximated in dead-code
};

const CONFIGS: Record<string, CallGraphConfig> = {
  python: PYTHON,
  javascript: JS,
  typescript: TS,
  tsx: TS,
  go: GO,
};

export function configFor(key: string): CallGraphConfig | undefined {
  return CONFIGS[key];
}

export function hasConfig(key: string): boolean {
  return key in CONFIGS;
}
