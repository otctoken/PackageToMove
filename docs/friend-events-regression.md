# Explicit friend restoration (2026-11-09)

The uploaded audit ZIP for
`0xfed8f891e64a8bd76c30eac4694611f63f7ba151c5d0eb19de67d7b9b24de395`
contains 5 ordinary packages, 37 modules and 628 functions. Archive SHA-256:
`c31ffb315f603eec0616deb23a6376fe9c965433ff92e4b5a2585a2ee6f87132`.
The regression fixture preserves its original bytecode and per-module hashes.

## Cause

The previous export replaced explicit `friend` / `public(friend)` with Move 2024
`public(package)`. Mysten's compiler synthesizes the friend list from actual
package-visible calls; it does not reconstruct unused declarations.
The original `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events`
has four friends: `admin`, `config`, `pool`, `tick`. Only `admin` and `pool`
call its friend functions. The other two therefore disappeared on compilation.
This module has real functions and structs; the old empty-module exception did not apply.

Compiler reference: vendored Mysten/Sui revision
`bf4073918ed33cfa0b09c500658fa116a774bcfd`,
`move-compiler/src/expansion/translate.rs::check_visibility_modifiers`,
`move-compiler/src/typing/translate.rs` (`all_new_friends`), and `editions/mod.rs`.

## Generic correction

- Export chooses editions per package from original function visibility and call
  instructions. If the 2024 call graph can regenerate every original friend,
  retain 2024. Otherwise use the legacy renderer when available.
- Both renderers use the same refined AST. Legacy emits braces, explicit vector
  calls, parenthesized casts, implicit local mutability and explicit friend syntax.
  Cross-loop transfers use a fresh local dispatch tag to propagate to the original
  target; three-level break/continue tests compare observable order and iteration counts.
- Enums or otherwise unsupported legacy constructs remain unavailable. The 2024
  fallback is still subject to the exact binary permission gate. Unsupported
  combinations are not silently certified as permission-equivalent.
- Original sources, original bytecode, hashes and expected permissions remain in
  the export. New-package relocation changes only root module identities as declared.
- No injected friend-calling functions, fake calls, edited bytecode or address allowlist.
  No permission normalization. Even empty modules must preserve their complete table.

## Validation

Using official `sui 1.82.3-bf4073918ed3`:

- Uploaded events project: audit and new-package compile; all 37 friend tables match.
  `events` retains all four friends. New-package generates offline publication input.
- Delete one unused friend from the generated source: compilation still succeeds,
  but `verify.mjs` exits 1, `friendAclPassed=false`, `friendTablesIdentical=false`,
  and reports the missing permission. This negative test also runs in Linux CI.
- Authority project: both modes compile, all 37 ACLs match, including the previously
  omitted empty tables (`constants`: 8 friends; `order_id`: 1).
- Existing optimizer (1,067 functions), efbfd (295), and math (168) instruction-model
  regressions remain mandatory. No comparator rule is relaxed for this change.

The initial events instruction comparison was incomplete: that legacy output
had 419 normalized-identical functions, 181 additional model matches and 28
unverified functions. Legacy vector calls versus vector bytecode operations are
among the differences the model does not confirm. The strict comparison exits
nonzero and was not reported as a successful equivalence check.
The subsequent [vector instruction review](vector-instruction-review.md) corrects
the renderer and retains literal boolean branches. All 628 functions now pass
the unchanged model (426 normalized-identical, 202 additional matches, 0 unverified).
Compilation and exact friend ACLs do not prove complete business-logic equivalence,
historical dependency equivalence, gas equivalence or deployability as the original identity.
Generated projects contain zero recovered business tests. No transaction is sent.

```sh
cargo build --bin verify_package --bin compare_project
npm run test:friend-events-build -- .research/friend-events
npx tsx scripts/test-friend-acl-tamper.ts .research/friend-events/audit
npm run test:authority-build
# Mandatory CI regression; fails if any function remains unverified:
npm run test:friend-events-roundtrip
```
