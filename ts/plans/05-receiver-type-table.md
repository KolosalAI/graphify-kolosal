# Plan 05 — Receiver Type Table (promote method dispatch to EXTRACTED)

**Goal:** Resolve member calls (`recv.method()`) to the *exact* class's method by knowing
the **type of the receiver**, upgrading [Plan 04](04-call-graph.md)'s name-based method
dispatch (currently `INFERRED`/`AMBIGUOUS`) to `EXTRACTED` — and enabling virtual-dispatch
handling across inheritance. This is the port/generalization of the per-file `type_table`
graphify builds in `extract.py`.

## What changes vs Plan 04

Plan 04 resolves `d.bark()` by method **name** only: unique `bark` → `INFERRED`, multiple →
`AMBIGUOUS`. That's imprecise the moment two classes both have `bark`. With a type table we
know `d : Dog`, look up `bark` on `Dog` (or its bases), and emit an `EXTRACTED` edge to the
one right method.

```
Plan 04:  d.bark()  →  methodGlobal["bark"]  →  INFERRED / AMBIGUOUS
Plan 05:  d.bark()  →  typeOf(d)=Dog  →  method "bark" on Dog(+bases)  →  EXTRACTED
```

## The type table

A **scoped** map from a name (variable/param/field/`self`) to a resolved class node id.

```ts
export interface TypeBinding {
  name: string;          // variable / param / field name (or "self"/"this")
  typeName: string;      // declared or inferred type name (e.g. "Dog")
  origin: "annotation" | "instantiation" | "return" | "self" | "param";
  scope: string;         // owning callable/class/module id
}
export interface TypeTable {
  // resolved lookups (Pass 2, after class symbols exist)
  typeOf(name: string, scope: string): string | undefined; // → class node id
}
```

Resolution confidence follows the binding origin:

| Origin | Example | Confidence of the resulting call edge |
|---|---|---|
| `annotation` | `d: Dog`, `let d: Dog`, `(d: Dog) =>` | `EXTRACTED` |
| `instantiation` | `d = Dog()` / `new Dog()` | `EXTRACTED` |
| `self`/`this` | method body `self.m()` | `EXTRACTED` (enclosing class) |
| `param` (untyped) | inferred elsewhere | `INFERRED` |
| `return` | `d = makeDog()` where `makeDog(): Dog` | `INFERRED` |
| unknown | receiver type not derivable | fall back to Plan 04 name-based |

## Sources of type information (Pass 1 additions → `TypeIR`)

Collected during the existing single AST walk, appended to `FileIR`:

- **Instantiation:** assignment/declarator whose value is a constructor call
  (`new_expression`, or a call to a known class name) → `name : ClassName`.
- **Explicit annotations:** typed variable declarations and **typed parameters**
  (`d: Dog`), TS/Java/Go/Kotlin/Swift. Read the type node's identifier.
- **`self`/`this`:** inside a method, bind the receiver keyword to the enclosing class.
- **Field types:** class field/property declarations with a type → `field : Type` in class
  scope (so `this.x.m()` can chain one level).
- **Return types (optional):** function/method return annotations feed `return`-origin
  bindings for `x = f()`.

```ts
export interface TypeIR {
  bindings: TypeBinding[];      // name → typeName with origin + scope
  fieldTypes: TypeBinding[];    // class fields
  methodReturns: Record<string, string>; // defId → return type name (for return-origin)
}
```

## Config additions (per language)

Extend `CallGraphConfig` (Plan 04) with type hooks; absent → no type table, graceful
fallback to name-based dispatch:

```ts
selfKeyword?: string;              // "self" (py) / "this" (js/ts/java) — enclosing-class bind
typedParamTypes?: Set<string>;     // typed_parameter / required_parameter …
typeAnnotationField?: string;      // field holding the type on a param/var ("type")
varDeclTypes?: Set<string>;        // declarations that can carry a type/annotation
fieldDeclTypes?: Set<string>;      // class field/property declarations
returnTypeField?: string;          // function return-type field (TS/Go/Java)
newExprTypeField?: string;         // constructor node's type field ("constructor")
```

Seed: **python** (`typed_parameter`, `: Type`, `self`, `X()` instantiation), **TS/JS**
(`this`, `: Type` annotations, `new X()`), then Java/C#/Kotlin/Swift/Go.

## Pass 2 integration

1. **Class method tables:** for each class node, build `methods: name → methodId`,
   **including inherited** methods by walking `inherits` edges (Plan 04 already emits them).
   Cache per class; detect cycles.
2. **Resolve type bindings:** map each `TypeBinding.typeName` → a class node id (same-file
   first, then imported, then global-unique — same tiers as call resolution). Build the
   scoped `typeOf(name, scope)`.
3. **Re-resolve member calls** (replaces Plan 04 tier 3/4 for `method`/`super` forms):
   - `recv.m()` → `cls = typeOf(recv, callerScope)`.
     - `cls` known and `m` ∈ `cls.methods` → **`EXTRACTED`** edge to that method.
     - `cls` known, `m` only on **subtypes that override** → `AMBIGUOUS` across the override
       set (virtual dispatch), or `EXTRACTED` if the declared type itself defines `m`.
     - `cls` unknown → fall back to Plan 04 name-based (`INFERRED`/`AMBIGUOUS`).
   - `super.m()` → resolve on the enclosing class's **base**.
   - `self.m()`/`this.m()` → enclosing class's method (`EXTRACTED`).

## Inheritance & virtual dispatch

- `inherits`/`implements` edges (Plan 04) give the class hierarchy. Method lookup walks up
  bases (MRO-ish, first match wins).
- A call typed to a base class whose method is overridden in known subtypes is genuinely
  polymorphic → emit `AMBIGUOUS` to the base + overrides (configurable: declared-type-only
  for precision, or full override set for recall). Record the choice in the edge.

## Cross-file types

Resolving `typeName → class id` reuses the import map: a receiver typed to an imported
class resolves to that class in its defining module. Unresolvable external types (stdlib,
third-party) leave the call on the name-based fallback.

## Proposed layout & API

```
ts/src/graph/
  types.ts       # TypeTable, TypeBinding, TypeIR, buildTypeTable(irs) -> scoped lookup
  (extract.ts)   # + collect TypeIR during the Pass-1 walk
  (resolve.ts)   # + class method tables (with inheritance) + typed member-call resolution
  (config.ts)    # + type hooks per language
```

The public `generateCallGraph` signature is unchanged — the type table is internal. Add
`opts.methodDispatch?: "typed" | "name"` (default `"typed"`) to fall back to Plan 04
behavior for debugging/comparison, and `opts.virtualDispatch?: "declared" | "overrides"`.

## Verification (definition of done)

1. **Two classes, same method name:** `class Dog{ bark() } class Seal{ bark() }; d=Dog();
   d.bark()` → **`EXTRACTED`** edge to `Dog.bark` only (Plan 04 would give `AMBIGUOUS`).
2. **Annotation:** `def f(d: Dog): d.bark()` → `EXTRACTED` to `Dog.bark` with no
   instantiation in scope.
3. **`self`/`this`:** a method calling `self.other()` → `EXTRACTED` to the same class's
   `other`.
4. **Inheritance:** `class Pup(Dog): ...; p=Pup(); p.bark()` resolves `bark` via `Dog`
   (inherited) → `EXTRACTED`.
5. **Virtual override:** base-typed receiver whose subtype overrides the method →
   `AMBIGUOUS` across the override set under `virtualDispatch:"overrides"`, single
   `EXTRACTED` under `"declared"`.
6. **Fallback:** unknown receiver type still yields the Plan 04 name-based edge (no
   regression, no crash).
7. **Cross-file:** receiver typed to an imported class resolves to that class's method.

## Risks / open questions

- **No full type inference:** reassignment, unions, generics, duck typing, and chained
  member access beyond one level are out of scope — best-effort, then fall back. Precision
  over recall.
- **Dynamic languages:** python/JS receivers are often untyped; the win is largest with
  annotations + local instantiation. Measure the `EXTRACTED` uplift vs Plan 04.
- **Override-set explosion:** deep hierarchies can make `AMBIGUOUS` noisy; default to
  declared-type precision, expose the override mode.
- **`self`-chains:** `this.svc.handle()` needs field types; support one hop, document the
  limit.

## Phasing

1. `config.ts` type hooks (python/TS first) + `TypeIR` collection in `extract.ts`.
2. `types.ts` — `buildTypeTable(irs)`: resolve type names → class ids, scoped `typeOf`.
3. Class method tables with inheritance in `resolve.ts`; re-resolve member/`self`/`super`
   calls to `EXTRACTED`.
4. Virtual-dispatch modes + cross-file types; smoke tests (cases above).
5. Extend type hooks to Java/C#/Kotlin/Swift/Go; feed the higher-precision graph to Plan 06.

---

## Execution status (implemented in `ts/src/graph/`)

- **`config.ts`** gained type hooks: `selfKeyword`, `typedParamTypes`, `typeBindingDeclTypes`,
  `fieldDeclTypes`, `newExprTypeField` (python + JS/TS; TS inherits JS's).
- **`model.ts`** — `TypeBinding` + `FileIR.typeBindings`; `CallGraphOptions` gained
  `methodDispatch` (`"typed"` default / `"name"`) and `virtualDispatch` (`"declared"` /
  `"overrides"`).
- **`extract.ts`** (Pass 1) now collects type bindings: typed params, `self`/`this` →
  enclosing class, `d = Dog()` / `new Dog()` instantiation, `d: Dog` annotations, and TS
  class fields — scoped to the owning def/class/module.
- **`types.ts`** — `buildTypeResolver`: class method tables with **inheritance** lookup
  (walks `inherits` bases), scoped `typeOf`, and `resolveMember`/`resolveInClass`/
  `resolveSuper` with optional override fan-out.
- **`resolve.ts`** — method/`self`/`super` calls resolve through the type table
  (`EXTRACTED`) and **fall back** to Plan 04 name-based (`INFERRED`/`AMBIGUOUS`) when the
  receiver type is unknown. No regression.
- **Verified — `npm run graph-smoke` → 20/20** (5 new): two classes with the same method
  name disambiguate (`d.bark()` → `Dog.bark` EXTRACTED, no `Seal.bark` edge); `self.b()` →
  same-class method; annotated param `x: A` → `A.a`; TS `new Cat()` inherits
  `Animal.speak`. `npm run typecheck` clean; `node dist/main.js` rebuilt.
- **Measured uplift** on the demo zip: method-dispatch confidence went from
  `{EXTRACTED:18, INFERRED:2}` → **`{EXTRACTED:20}`** (`this.norm()` self-dispatch and
  `new Service()` instantiation now resolve exactly).

### Deviations / v1 limits
- Type sources: params, `self`/`this`, local instantiation, annotations, TS fields. **Not**
  handled: reassignment, unions/generics, multi-hop field chains (`this.svc.handle()`),
  return-type propagation (`origin:"return"` typed but not emitted).
- `virtualDispatch` defaults to `"declared"` (precision); `"overrides"` fan-out implemented
  but off by default.
- Type hooks cover python/JS/TS; Go/others still name-based (graceful fallback).
