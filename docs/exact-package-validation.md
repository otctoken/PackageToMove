# Exact package validation (2026-09-08)

## Follow-up: official system dependencies (supersedes full-framework export)

Addresses 0x1 through 0x8 are now excluded from analysis traversal and all
decompilation jobs. They remain visible as skipped metadata entries. Root and
third-party source still undergo the same audit gate; skipped system sources
cannot enter Download All. std/sui resolve implicitly via Sui CLI, and 0x3 is
declared with `sui_system = { system = "sui_system" }`.

The ac55 export now contains 7 files (2 root sources, 2 disassemblies, Move.toml,
manifest.json and README.md). That actual exported project builds successfully
using CLI 1.75.2. `sui move test` initially reports zero tests; after adding the
locally authored `tests/fixtures/ac55-smoke.move` to the generated tests directory,
all four tests pass. No deployment was attempted.

The 0x2 v57 GraphQL linkage really returns 0x1 version 0. This is **not** a
historical stdlib version pin: Sui's `MovePackage::new_system` intentionally sets
system-to-system linkage versions to zero because only one system package
version can be in use on a network at a time. The previous warning interpreted
this sentinel as a normal dependency conflict. See [official implementation](https://github.com/MystenLabs/sui/blob/main/crates/sui-types/src/move_package.rs).

Official dependency resolution is documented in [Move package management](https://docs.sui.io/develop/manage-packages/move-package-management).
The generated Move.lock pins build dependencies, not a proof that their source
matches a historical mainnet snapshot. For historical audits the chain bytecode
and execution checkpoint remain authoritative. The archive still does not claim
semantic equivalence or automatic republication compatibility.

## Earlier full-framework experiment

## Reproduced wrong-package resolution

Requested mainnet package:
`0xac55259d62fd8c30dd638f46afab109bc6a1066c4e92093b791d60e6bad266e7`.

The exact object is version 1, with modules `ll` (8 functions) and `session`
(20 functions). The old GraphQL `package(address:)` query instead returned
`0x2db4bc4a188101d82f985cc2f77bc27f9f94f68911bbed2087c75d679f1e3d22`, version 7,
with `bisect`, `ll`, `session`; the latter session has 40 functions.
This is package substitution, not merely a pretty-printer difference.

The regression fixture `tests/fixtures/exact-ac55.json` contains the exact
object's module bytes and linkage. All chain queries now use object/asMovePackage,
and validate returned identity. Download workers additionally compare SHA-256
against the analysis response. Matching counts alone no longer hides different
function symbols.

## Actual checks, and their limits

- Root ll/session decompiled from the fixture build with Sui CLI
  `1.75.2-027e13b2c140` using the CLI-provided framework dependencies.
- Four locally authored smoke tests passed: ladder constants and rounding,
  ll wrap/unwrap, invalid rung abort 101, zero-principal abort 112.
  These are not recovered publisher tests or an equivalence proof.
- Full export of the exact root plus MoveStdlib v25 and Sui v57 produces
  90 decompiled modules and 185 files, with all current coverage gates passing.
- **That full source dependency project does not build yet.** Actual compiler
  checks expose legacy friend visibility, incompatible conditional types,
  identifier escaping, and compiler-native mapping problems. The root-only build
  must not be represented as successful validation of the full archive.
- No publication, upgrade or other blockchain transaction was performed.
- Frontend tests, TypeScript checking, Next production build, and 13 Rust core
  regressions pass. The Linux API cross-check is blocked on this Windows host by
  missing Linux C headers; a native API check also encounters an upstream
  Windows-only vercel_runtime compile error. Neither is reported as an API
  deployment success.

Corrections include register names (not debug register/type strings), mutable
bindings, native declarations, friend declarations, cast grouping, uppercase
datatype aliases and hexadecimal address literals. Remaining compiler failures
must be addressed without broadening access or changing evaluation order.

## Reproduction

```sh
npm test
npm run lint
npm run build
cargo test --lib
cargo build --bin verify_package
npx tsx scripts/export-chain-project.ts 0xac55259d62fd8c30dd638f46afab109bc6a1066c4e92093b791d60e6bad266e7 <new-directory>
sui move build --path <new-directory> --silence-warnings
```

The archive keeps each dependency a separate local package. Root framework
linkage wins over older child framework linkage, with both versions recorded.
Non-framework conflicting versions or incomplete dependencies reject export.
The manifest explicitly marks build and semantic equivalence as unverified.
Do not use instruction counts or a bytecode-verifier badge as an audit conclusion.
