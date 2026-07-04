// Pass 1 (Plan 04): walk one file's serialized AST -> FileIR (defs, calls, imports,
// aliases, inheritance). Pure over AstNode; no live tree. Config-driven per language.
import type { AstNode } from "../parse/ast.js";
import { configFor } from "./config.js";
import type { Argument, CallForm, DefIR, FileAst, FileIR, ImportIR, ReturnBinding, Span } from "./model.js";

function baseNoExt(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
function childByField(node: AstNode, field: string): AstNode | undefined {
  return node.children.find((c) => c.field === field);
}
function firstChildOfType(node: AstNode, types: Set<string>): AstNode | undefined {
  return node.children.find((c) => types.has(c.type));
}
function text(node: AstNode | undefined, src?: string): string {
  if (!node) return "";
  if (node.text !== undefined) return node.text;
  return src !== undefined ? src.slice(node.startIndex, node.endIndex) : "";
}
function isIdentifier(node: AstNode | undefined): boolean {
  return !!node && node.children.length === 0 && /identifier/.test(node.type);
}
const span = (n: AstNode): Span => ({ startIndex: n.startIndex, endIndex: n.endIndex });

export function extractFileIR(ast: FileAst): FileIR {
  const relPath = ast.relPath;
  const moduleId = `module:${relPath}`;
  const ir: FileIR = {
    relPath,
    key: ast.key,
    moduleId,
    moduleSpan: span(ast.root),
    defs: [],
    calls: [],
    imports: [],
    aliases: [],
    inherits: [],
    typeBindings: [],
  };
  const cfg = configFor(ast.key);
  if (!cfg) return ir; // graceful degradation: module-only

  const src = ast.source;
  const moduleLabel = baseNoExt(relPath);
  const callerStack: string[] = [moduleId]; // enclosing callable
  const ownerStack: string[] = [moduleId]; // enclosing def/class/module (for contains)
  const classStack: string[] = []; // class names for qualifying methods

  const mkDef = (kind: DefIR["kind"], name: string, node: AstNode): DefIR => {
    const className = classStack[classStack.length - 1];
    const inClass = classStack.length > 0;
    const qualifiedName =
      kind === "method" && inClass ? `${className}.${name}` : `${moduleLabel}.${name}`;
    const prefix =
      kind === "method" ? "method" : kind === "lambda" ? "lambda" : kind === "class" ? "class" : kind === "interface" ? "iface" : "func";
    const id =
      kind === "lambda"
        ? `lambda:${relPath}@${node.startIndex}`
        : `${prefix}:${relPath}#${qualifiedName}@${node.startIndex}`;
    const def: DefIR = {
      id,
      kind,
      name,
      qualifiedName,
      className: kind === "method" ? className : undefined,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      scope: ownerStack[ownerStack.length - 1],
    };
    ir.defs.push(def);
    return def;
  };

  const inferReturn = (parent: AstNode | undefined): ReturnBinding => {
    if (!parent) return { kind: "discarded" };
    const t = parent.type;
    if (t === "return_statement") return { kind: "returned" };
    if (t === "await" || t === "await_expression") return { kind: "awaited" };
    if (t === "yield" || t === "yield_expression") return { kind: "yielded" };
    if (t === "assignment" || t === "variable_declarator" || t === "assignment_expression") {
      const nameChild = childByField(parent, "left") ?? childByField(parent, "name");
      return { kind: "bound", name: text(nameChild, src) || undefined };
    }
    return { kind: "discarded" };
  };

  const recordCall = (node: AstNode, parent: AstNode | undefined) => {
    const caller = callerStack[callerStack.length - 1];
    const isNew = cfg.constructorCallTypes.has(node.type);
    const callee = childByField(node, cfg.callCalleeField) ?? childByField(node, "constructor");
    if (!callee) return;

    let calleeName = "";
    let receiver: string | undefined;
    let form: CallForm = isNew ? "constructor" : "direct";

    if (cfg.accessorTypes.has(callee.type)) {
      calleeName = text(childByField(callee, cfg.accessorNameField), src);
      receiver = text(childByField(callee, cfg.accessorObjectField), src);
      form = receiver === cfg.superKeyword && cfg.superKeyword ? "super" : "method";
    } else if (isIdentifier(callee)) {
      calleeName = text(callee, src);
    } else {
      calleeName = text(callee, src);
      form = "dynamic";
    }

    // arguments
    const argsNode = childByField(node, cfg.argsField);
    const argNames: string[] = [];
    const lambdaArgIds: string[] = [];
    const args: Argument[] = [];
    if (argsNode) {
      let pos = 0;
      for (const a of argsNode.children) {
        if (!a.named) continue;
        if (cfg.lambdaTypes.has(a.type)) {
          const lid = `lambda:${relPath}@${a.startIndex}`;
          lambdaArgIds.push(lid);
          args.push({ position: pos, kind: "lambda", ref: lid });
        } else if (isIdentifier(a)) {
          const nm = text(a, src);
          argNames.push(nm);
          args.push({ position: pos, kind: "callable-ref", text: nm });
        } else {
          args.push({ position: pos, kind: "value", text: text(a, src).slice(0, 60) });
        }
        pos++;
      }
    }

    ir.calls.push({
      caller,
      calleeName,
      receiver,
      form,
      argNames,
      lambdaArgIds,
      returns: inferReturn(parent),
      args,
      site: span(node),
    });
  };

  const handleAliasOrArrowDecl = (node: AstNode): "arrow" | "alias" | null => {
    const nameChild = childByField(node, "name") ?? childByField(node, "left");
    const valueChild = childByField(node, "value") ?? childByField(node, "right");
    if (!nameChild || !valueChild || !isIdentifier(nameChild)) return null;
    if (cfg.lambdaTypes.has(valueChild.type)) return "arrow";
    if (isIdentifier(valueChild)) {
      ir.aliases.push({
        name: text(nameChild, src),
        target: text(valueChild, src),
        scope: callerStack[callerStack.length - 1],
      });
      return "alias";
    }
    return null;
  };

  const recordInherits = (classId: string, classNode: AstNode) => {
    const supers = childByField(classNode, "superclasses"); // python argument_list
    const bases: string[] = [];
    if (supers) for (const c of supers.children) if (isIdentifier(c)) bases.push(text(c, src));
    // JS: scan class_heritage for identifiers
    const heritage = firstChildOfType(classNode, new Set(["class_heritage"]));
    if (heritage) {
      const stack = [heritage];
      while (stack.length) {
        const n = stack.pop()!;
        if (isIdentifier(n)) bases.push(text(n, src));
        for (const c of n.children) stack.push(c);
      }
    }
    for (const b of bases) ir.inherits.push({ from: classId, to: b });
  };

  // Plan 05: first identifier-ish leaf under a type node ("Dog" from `: Dog` / `List[Dog]`).
  const typeNameOf = (typeNode: AstNode | undefined): string => {
    if (!typeNode) return "";
    const q = [typeNode];
    while (q.length) {
      const n = q.shift()!;
      if (n.children.length === 0 && /identifier/.test(n.type)) return text(n, src);
      for (const c of n.children) q.push(c);
    }
    return "";
  };
  const paramName = (p: AstNode): string => {
    const patt = childByField(p, "pattern");
    if (isIdentifier(patt)) return text(patt, src);
    const id = p.children.find((c) => isIdentifier(c));
    return id ? text(id, src) : "";
  };
  const extractParamTypes = (defNode: AstNode, scopeId: string) => {
    if (!cfg.typedParamTypes) return;
    const params = childByField(defNode, "parameters");
    if (!params) return;
    for (const p of params.children) {
      if (!cfg.typedParamTypes.has(p.type)) continue;
      const nm = paramName(p);
      const tn = typeNameOf(childByField(p, "type"));
      if (nm && tn) ir.typeBindings.push({ name: nm, typeName: tn, origin: "annotation", scope: scopeId });
    }
  };
  // `d: Dog`, `d = Dog()`, `const d = new Dog()`, class fields — scoped to the owner.
  const detectTypeBinding = (node: AstNode, scope: string) => {
    const nameChild = childByField(node, "name") ?? childByField(node, "left") ?? childByField(node, "pattern");
    if (!isIdentifier(nameChild)) return;
    const name = text(nameChild, src);
    const typeNode = childByField(node, "type");
    const value = childByField(node, "value") ?? childByField(node, "right");
    let typeName = "";
    let origin: "annotation" | "instantiation" = "annotation";
    if (typeNode) {
      typeName = typeNameOf(typeNode);
    } else if (value) {
      if (value.type === "new_expression") {
        typeName = text(childByField(value, cfg.newExprTypeField ?? "constructor") ?? childByField(value, "function"), src);
        origin = "instantiation";
      } else if (cfg.callTypes.has(value.type)) {
        const callee = childByField(value, cfg.callCalleeField);
        if (isIdentifier(callee)) { typeName = text(callee, src); origin = "instantiation"; }
      }
    }
    if (typeName) ir.typeBindings.push({ name, typeName, origin, scope });
  };

  // Plan 07: mark a def exported (parent is an export node) and capture decorator names
  // (parent is a decorated_definition, python) so dead-code can spot framework entries.
  const applyEntryMeta = (def: DefIR, _node: AstNode, parent: AstNode | undefined) => {
    if (parent && cfg.exportMarkers?.has(parent.type)) def.exported = true;
    if (parent && parent.type === "decorated_definition") {
      const names: string[] = [];
      for (const c of parent.children) {
        if (c.type !== "decorator") continue;
        const raw = text(c, src).replace(/^@/, "").split("(")[0].trim();
        if (raw) names.push(raw);
      }
      if (names.length) def.decorators = names;
    }
  };

  const visit = (node: AstNode, parent: AstNode | undefined) => {
    const t = node.type;

    // const g = () => …   (named function via declarator)   OR   const g = f (alias)
    if (cfg.aliasDeclTypes.has(t)) {
      const kind = handleAliasOrArrowDecl(node);
      if (kind === "arrow") {
        const nameChild = childByField(node, "name") ?? childByField(node, "left")!;
        const valueChild = (childByField(node, "value") ?? childByField(node, "right"))!;
        const def = mkDef("function", text(nameChild, src), valueChild);
        callerStack.push(def.id);
        ownerStack.push(def.id);
        for (const c of valueChild.children) visit(c, valueChild);
        callerStack.pop();
        ownerStack.pop();
        return; // consumed the value node
      }
      // alias or nothing special → fall through to normal recursion
    }

    // class / interface
    if (cfg.classTypes.has(t) || cfg.interfaceTypes.has(t)) {
      const nameChild = childByField(node, cfg.nameField);
      const name = text(nameChild, src) || "<anonymous>";
      const kind = cfg.interfaceTypes.has(t) ? "interface" : "class";
      const def = mkDef(kind, name, node);
      applyEntryMeta(def, node, parent);
      recordInherits(def.id, node);
      ownerStack.push(def.id);
      classStack.push(name);
      for (const c of node.children) visit(c, node);
      classStack.pop();
      ownerStack.pop();
      return;
    }

    // function / method / lambda
    const isMethod = cfg.methodTypes.has(t) || (cfg.functionTypes.has(t) && classStack.length > 0);
    const isFunction = cfg.functionTypes.has(t) && classStack.length === 0;
    const isLambda = cfg.lambdaTypes.has(t);
    if (isMethod || isFunction || isLambda) {
      const nameChild = childByField(node, cfg.nameField);
      const name = isLambda ? `<lambda@${node.startIndex}>` : text(nameChild, src) || "<anonymous>";
      const kind = isMethod ? "method" : isLambda ? "lambda" : "function";
      const def = mkDef(kind, name, node);
      applyEntryMeta(def, node, parent); // Plan 07: exported / decorators
      extractParamTypes(node, def.id); // Plan 05: typed params
      if (isMethod && cfg.selfKeyword && classStack.length) {
        ir.typeBindings.push({ name: cfg.selfKeyword, typeName: classStack[classStack.length - 1], origin: "self", scope: def.id });
      }
      callerStack.push(def.id);
      ownerStack.push(def.id);
      for (const c of node.children) visit(c, node);
      callerStack.pop();
      ownerStack.pop();
      return;
    }

    // Plan 05: variable/field type bindings (`d: Dog`, `d = Dog()`, class fields)
    if (cfg.typeBindingDeclTypes?.has(t) || cfg.fieldDeclTypes?.has(t)) {
      detectTypeBinding(node, ownerStack[ownerStack.length - 1]);
    }

    // call
    if (cfg.callTypes.has(t)) recordCall(node, parent);

    // import
    if (cfg.importTypes.has(t)) ir.imports.push(extractImport(node, ast.key, src));

    for (const c of node.children) visit(c, node);
  };

  visit(ast.root, undefined);
  return ir;
}

// Language-tolerant import extraction. The source module is taken from the `module_name`
// field (python `from X import …`) or a `source` string (JS `… from '...'`), and imported
// names are the identifiers outside that source span. Falls back to the `name` field for
// python `import X`.
function extractImport(node: AstNode, _key: string, src?: string): ImportIR {
  let from = "";
  let fromStart = -1;
  let fromEnd = -1;
  const findFrom = (n: AstNode): boolean => {
    if (n.field === "module_name") { from = text(n, src); fromStart = n.startIndex; fromEnd = n.endIndex; return true; }
    if (/string/.test(n.type) && n.field === "source") { from = text(n, src).replace(/^['"`]|['"`]$/g, ""); fromStart = n.startIndex; fromEnd = n.endIndex; return true; }
    for (const c of n.children) if (findFrom(c)) return true;
    return false;
  };
  findFrom(node);
  if (!from) {
    // JS without an explicit `source` field, or python `import X`
    const strChild = node.children.find((c) => /string/.test(c.type));
    const nameChild = node.children.find((c) => c.field === "name");
    const pick = strChild ?? nameChild;
    if (pick) { from = text(pick, src).replace(/^['"`]|['"`]$/g, ""); fromStart = pick.startIndex; fromEnd = pick.endIndex; }
  }

  const names: string[] = [];
  const collect = (n: AstNode) => {
    if (n.children.length === 0 && /identifier/.test(n.type)) {
      const inSource = n.startIndex >= fromStart && n.endIndex <= fromEnd && fromStart >= 0;
      if (!inSource) names.push(text(n, src));
    }
    for (const c of n.children) collect(c);
  };
  collect(node);
  return { names, from };
}
