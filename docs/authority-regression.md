# Authority keyword and project build regression

Mainnet root: `0x913188180e04b6291c9621b62b893565274c798bb9d07e67c81417d27cf15a6d`.
The exact-object fixture contains 9 ordinary packages, 37 modules and 847 functions.
System packages remain official toolchain dependencies.

The uploaded `0x913188180e04b6291c9621b62b893565274c798bb9d07e67c81417d27cf15a6d-mainnet-audit.zip`
has SHA-256 `7881f065acbedd7b8e93b3252d1999e99c24351885665eccaa21d38e2b8b5552`.
All 37 module hashes in that archive match this immutable-bytecode fixture.
Its unmodified project reproduces the reported compiler failure.

## Compilation defects

- `authority` in package `0x4e2df80a5e2fd0392878298c51ce15164222111ccea05504b9291b158f552677`
  uses `for` as both a field and a public function name. Move 2024 output must escape
  these names with backticks in definitions, construction, destructuring, access and calls.
  The coverage checker counts escaped calls and preserves the original function identity.
  The same escaping is applied to module/type paths, imports and aliases. Regression
  tests rename the actual bytecode field/function to each of the 28 lexer keywords;
  escaped `fun` identifiers must not inflate the function count.
- `enum_option` used tag inspection followed by reference/value unpacks. Standalone
  `let Enum::Variant` is not valid Move. A conservative refinement folds straight-line,
  alias-checked unpacks into a match pattern. It rejects different source values, live
  bindings whose reference type would change, repeated value consumption, and remaining
  uses of the whole enum. Tag-only patterns for variants with fields include `{ .. }`.
- `settle_position_funding` and `clearing_house` contained complementary guarded paths
  emitted as independent `if` statements. The compiler could not prove definite assignment.
  A bounded truth-table check proves complementarity of pure Boolean formulas, then emits
  an exhaustive `if/else`. Predicate mutation and unsafe motion across the prefix/payload
  are rejected. No fabricated initial values are assigned to original bytecode locals.
  Uses of bindings declared inside the conditional prefix are never moved out of scope;
  the existing optimizer project covers this boundary in a real build regression.
  A predicate mutably borrowed anywhere in the function is also rejected: mutation
  through a previously created reference alias need not mention the predicate name.

## Validation on 2026-11-03

Sui CLI: `1.82.3-bf4073918ed3`.

- Both audit and new-package exports compile with `sui move build --build-env mainnet`.
- Both `sui move test` commands pass with **zero business tests**.
- Rust main library and decompiler engine regression tests cover the fixes and rejection cases.
- Frontend tests and TypeScript checks pass.
- All 37 modules retain function interfaces and struct/enum layouts. Of 847 functions,
  433 have identical normalized instructions, 408 match the experimental v2 paired-instruction
  model, and **6 remain unverified** (previously 23 under v1). These include enum reconstruction, borrow forms
  and control-flow/evaluation-order differences that the model cannot confirm.
  The strict instruction-comparison command still exits nonzero. Neither compilation
  nor a model match is a complete semantic-equivalence proof.

**Historical result, superseded on 2026-11-09:** the earlier 2024 friend adapter did not
retain the unused original friend tables of two modules in package
`0x3ec740df8428aa9c93aaef7f8cc1542ac3194fd014826b51bfe245346d64efc7`:

| Module | Original friends | Rebuilt friends |
| --- | --- | --- |
| constants | 8 | 0 |
| order_id | 1 | 0 |

The 2026-11-09 [friend restoration](friend-events-regression.md) retains these tables
with explicit declarations and a legacy edition renderer. Both exports now compile and
all 37 friend tables match exactly, including `constants` (8) and `order_id` (1).
The empty-module exception has been removed. Default `node verify.mjs` rejects every
missing or added friend; `--require-exact-metadata` is retained as a compatible alias.
The numerical instruction and official-source comparisons above describe the earlier
2024 output, not a new equivalence certificate for the legacy-rendered output.

## Reproduction

```sh
cargo build --bin verify_package --bin compare_project
npm run test:authority-build
npm run test:authority-roundtrip
```

`test:authority-build` verifies all module coverage, both export builds/tests, friend access
checks and offline new-package publication input. It does not compare function instructions.
`test:authority-roundtrip` additionally runs the strict instruction comparator and currently
retains any unverified functions as failures; this must not be described as a passing check.

The subsequent [official-source investigation](source-equivalence.md) additionally compares
whole `CompiledModule` values without metadata normalization: 5 modules match, 32 differ.
Actual official verification with Sui 1.82.3 passes 1 of 9 packages and fails 8 on bytecode
differences. These are different criteria; instruction-model matches cannot override them.

Linux CI builds the actual Vercel Rust Function, runs both Rust test suites and installs the
official Sui 1.82.3 Ubuntu x86_64 release pinned by SHA-256. It runs the authority **build**
regression plus the existing optimizer build/instruction regression, retaining validation logs.
The build job is intentionally not advertised as a proof of authority instruction equivalence.

```sh
cargo test --lib
cargo test --manifest-path tests/decompiler-engine/Cargo.toml --lib
npm test
npm run lint
```

No transactions are submitted by these checks.
