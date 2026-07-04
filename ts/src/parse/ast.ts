// AST serialization (Plan 03) — capture a plain-JSON node tree while the live
// wasm Tree is still alive, so the AST can be inspected/persisted after the tree
// is freed. Also exposes errorCount and the S-expression form.

import type { Node } from "web-tree-sitter";

export interface AstNode {
  type: string; // node type, e.g. "function_definition"
  named: boolean; // named vs anonymous (punctuation/keywords)
  field?: string; // field name in parent, when any (e.g. "name", "body")
  startIndex: number; // UTF-16 offsets (see Plan 03 encoding caveat)
  endIndex: number;
  start: [row: number, col: number];
  end: [row: number, col: number];
  text?: string; // leaf text by default; internal nodes only when includeText
  missing?: boolean; // inserted MISSING node
  children: AstNode[];
}

export interface SerializeOptions {
  /** include text on internal nodes too (default: leaves only) */
  includeText?: boolean;
  /** drop anonymous nodes for a compact, readable tree */
  namedOnly?: boolean;
  /** stop descending past this depth */
  maxDepth?: number;
}

// web-tree-sitter has shifted some cursor members between getter and method across
// versions; read() tolerates both so serialization is version-robust.
function read(obj: any, name: string): any {
  const v = obj[name];
  return typeof v === "function" ? v.call(obj) : v;
}

/** Serialize a subtree to a plain-JSON AstNode. Field names are captured mid-walk. */
export function serializeAst(root: Node, opts: SerializeOptions = {}): AstNode {
  const cursor: any = root.walk();
  try {
    return build(cursor, opts, 0);
  } finally {
    cursor.delete();
  }
}

function build(cursor: any, opts: SerializeOptions, depth: number): AstNode {
  const sp = read(cursor, "startPosition");
  const ep = read(cursor, "endPosition");
  const node: AstNode = {
    type: read(cursor, "nodeType"),
    named: !!read(cursor, "nodeIsNamed"),
    startIndex: read(cursor, "startIndex"),
    endIndex: read(cursor, "endIndex"),
    start: [sp.row, sp.column],
    end: [ep.row, ep.column],
    children: [],
  };
  const field = read(cursor, "currentFieldName");
  if (field) node.field = field;
  if (read(cursor, "nodeIsMissing")) node.missing = true;

  let isLeaf = true;
  const atMax = opts.maxDepth !== undefined && depth >= opts.maxDepth;
  if (!atMax && cursor.gotoFirstChild()) {
    isLeaf = false;
    do {
      if (opts.namedOnly && !read(cursor, "nodeIsNamed")) continue;
      node.children.push(build(cursor, opts, depth + 1));
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
  // Reading text only for leaves by default keeps internal-node text (whole subtree)
  // out of the dump unless explicitly requested.
  if ((isLeaf && opts.includeText !== false) || opts.includeText === true) {
    node.text = read(cursor, "nodeText");
  }
  return node;
}

/** tree-sitter's built-in LISP-style S-expression — compact and human-readable. */
export function toSExpression(root: Node): string {
  return root.toString();
}

/** Count ERROR + MISSING nodes. Cheap short-circuit when the tree is clean. */
export function errorCount(root: Node): number {
  if (!(root as any).hasError) return 0;
  let count = 0;
  const stack: Node[] = [root];
  while (stack.length) {
    const n: any = stack.pop();
    if (n.type === "ERROR" || n.isMissing) count++;
    const kids: Node[] = n.children;
    for (const c of kids) stack.push(c);
  }
  return count;
}
