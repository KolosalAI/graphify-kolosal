// Receiver type table (Plan 05). Resolves member calls to a concrete method by knowing
// the receiver's type. Built from FileIR type bindings + class hierarchy after nodes exist.
import type { CallGraphOptions, Confidence, FileIR, GraphNode } from "./model.js";

export interface MemberResolution {
  targets: string[];
  confidence: Confidence;
}

export interface TypeResolver {
  /** `recv.method()` — resolve via the receiver's type in the caller's scope. */
  resolveMember(callerId: string, receiver: string, method: string): MemberResolution | null;
  /** `self.method()` / `this.method()` — resolve on the enclosing class. */
  resolveInClass(classId: string, method: string): MemberResolution | null;
  /** `super.method()` — resolve on the enclosing class's base(s). */
  resolveSuper(classId: string, method: string): MemberResolution | null;
}

export function buildTypeResolver(
  irs: FileIR[],
  byId: Map<string, GraphNode>,
  importedByFile: Map<string, Map<string, string>>,
  opts: CallGraphOptions,
): TypeResolver {
  // class name → id (per file + global)
  const classByFile = new Map<string, Map<string, string>>();
  const classGlobal = new Map<string, string[]>();
  // classId → (methodName → methodId), own methods only
  const ownMethods = new Map<string, Map<string, string>>();

  for (const n of byId.values()) {
    if (n.kind === "class" || n.kind === "interface") {
      let inner = classByFile.get(n.file);
      if (!inner) classByFile.set(n.file, (inner = new Map()));
      inner.set(n.name, n.id);
      const g = classGlobal.get(n.name);
      if (g) g.push(n.id); else classGlobal.set(n.name, [n.id]);
    } else if (n.kind === "method" && n.scope) {
      let m = ownMethods.get(n.scope);
      if (!m) ownMethods.set(n.scope, (m = new Map()));
      m.set(n.name, n.id);
    }
  }

  const resolveTypeName = (typeName: string, file: string): string | undefined => {
    const local = classByFile.get(file)?.get(typeName);
    if (local) return local;
    const importedRel = importedByFile.get(file)?.get(typeName);
    const imported = importedRel ? classByFile.get(importedRel)?.get(typeName) : undefined;
    if (imported) return imported;
    const g = classGlobal.get(typeName);
    return g && g.length === 1 ? g[0] : undefined;
  };

  // classId → base classIds
  const bases = new Map<string, string[]>();
  for (const ir of irs) {
    for (const h of ir.inherits) {
      const baseId = resolveTypeName(h.to, ir.relPath);
      if (baseId) (bases.get(h.from) ?? bases.set(h.from, []).get(h.from)!).push(baseId);
    }
  }
  // invert for override fan-out
  const subclasses = new Map<string, string[]>();
  for (const [sub, bs] of bases) for (const b of bs) (subclasses.get(b) ?? subclasses.set(b, []).get(b)!).push(sub);

  // method lookup walks self then bases (first match wins), cycle-guarded
  const methodLookup = (classId: string, name: string): string | undefined => {
    const seen = new Set<string>();
    const q = [classId];
    while (q.length) {
      const c = q.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const mid = ownMethods.get(c)?.get(name);
      if (mid) return mid;
      for (const b of bases.get(c) ?? []) q.push(b);
    }
    return undefined;
  };

  // scope → (name → classId)
  const typeOf = new Map<string, Map<string, string>>();
  for (const ir of irs) {
    for (const b of ir.typeBindings) {
      const classId = resolveTypeName(b.typeName, ir.relPath);
      if (!classId) continue;
      let m = typeOf.get(b.scope);
      if (!m) typeOf.set(b.scope, (m = new Map()));
      if (!m.has(b.name)) m.set(b.name, classId);
    }
  }

  const lookupType = (scope: string, name: string): string | undefined => {
    let s: string | undefined = scope;
    const guard = new Set<string>();
    while (s && !guard.has(s)) {
      guard.add(s);
      const hit = typeOf.get(s)?.get(name);
      if (hit) return hit;
      s = byId.get(s)?.scope;
    }
    return undefined;
  };

  const overrideTargets = (classId: string, method: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const q = [...(subclasses.get(classId) ?? [])];
    while (q.length) {
      const c = q.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const mid = ownMethods.get(c)?.get(method);
      if (mid) out.push(mid);
      for (const s of subclasses.get(c) ?? []) q.push(s);
    }
    return out;
  };

  const withOverrides = (classId: string, declared: string, method: string): MemberResolution => {
    if (opts.virtualDispatch !== "overrides") return { targets: [declared], confidence: "EXTRACTED" };
    const extra = overrideTargets(classId, method).filter((id) => id !== declared);
    return extra.length
      ? { targets: [declared, ...extra], confidence: "AMBIGUOUS" }
      : { targets: [declared], confidence: "EXTRACTED" };
  };

  return {
    resolveMember(callerId, receiver, method) {
      const cls = lookupType(callerId, receiver);
      if (!cls) return null;
      const mid = methodLookup(cls, method);
      return mid ? withOverrides(cls, mid, method) : null;
    },
    resolveInClass(classId, method) {
      const mid = methodLookup(classId, method);
      return mid ? { targets: [mid], confidence: "EXTRACTED" } : null;
    },
    resolveSuper(classId, method) {
      for (const b of bases.get(classId) ?? []) {
        const mid = methodLookup(b, method);
        if (mid) return { targets: [mid], confidence: "EXTRACTED" };
      }
      return null;
    },
  };
}
