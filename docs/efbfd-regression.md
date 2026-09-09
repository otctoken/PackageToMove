# efbfd audit-project regression (2026-09-09)

Follow-up: the 56 remaining differences have now been investigated; one call-order
reconstruction defect was fixed. See [the per-function instruction review](efbfd-instruction-review.md).
The counts below record the earlier baseline, not the current result. Current:
200 normalized-identical functions, 95 matched under an experimental restricted
instruction model, zero unmatched in this exact regression. This is not a universal
or independently verified semantic-equivalence proof.
The intermediate assignment-only fix had 241 identical + 54 model-matched;
subsequent general evaluation-order protection retains more temporaries.

Input: user-provided audit ZIP for mainnet
`0xefbfd064480777699fd9c557a5804d72ace7bc82661fdc8d1f1a44ea6d92ee10` v2,
plus dependency `0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a` v1.
Exact-object GraphQL responses are captured under tests/fixtures/efbfd-*.json:
14 root modules and 24 dependency modules. The root bytecode's original runtime
address is 0x7b502c8a7bcb3915892347f11086745570e759fe9708d03c03accf4c90bbf580;
that differs legitimately from the upgraded package's storage ID and is retained.

## Reproduced defects

Original Sui build: 97 edition/friend errors, 8 incompatible-type errors,
12 invalid enum-pattern names, and 6 empty-variant construction errors.

- Pop was rendered as a bare expression. When tail return/continue elimination
  removed the following terminator, a discarded call result incorrectly became
  the block's value. Pop now emits `let _ = expression;`, retaining the effectful
  call and its value discard in branches, loops and function tails.
- Empty enum variants incorrectly used `{}`; match patterns omitted their enum
  qualification. Both printer rules are corrected without changing variant tags.
- Friend bytecode and 2024 enum syntax cannot be combined as literal friend
  source under the stock compiler. Canonical source remains in auditSourceFile;
  sources/ may be a clearly marked BUILD ADAPTER. No unconditional permission
  equivalence is asserted for public(package).

## Validation and limitations

Regenerated all 38 modules from chain bytes using the same Rust audit gate.
The actual rebuilt project passed Sui build with CLI 1.75.2. Every original
friend table matched both the export expectations and recompiled bytecode.
All 295 function interfaces (including private functions, entry flags, generic
constraints, parameter/return types), struct layouts and enum layouts match.
239 of the 295 normalized function bodies compare equal using the upstream
function comparator (which ignores local-declaration tables). The remaining
56 do NOT compare equal, so complete equivalence is not established; this check
must not be described as all bytecode matching.
The test command ran successfully with zero test cases; no business tests or
publication were claimed. Instruction coverage and friend-table equality do
not prove complete semantic equivalence, particularly with current official
framework dependencies versus a historical checkpoint.

```sh
cargo test --lib
cargo build --bin verify_package
npx tsx scripts/test-efbfd-project.ts <new-output-directory>
node <new-output-directory>/verify.mjs
cargo build --bin compare_project
# Run a non-test build first; test builds contain unpublishable bytecode headers.
sui move build --path <new-output-directory>
target/debug/compare_project tests/fixtures/efbfd-root.json <new-output-directory>/build
target/debug/compare_project tests/fixtures/efbfd-dependency.json <new-output-directory>/build
```

The runner fails on any missing/extra friend or missing compiled module. It
records a hash of the Move inputs and manifest, and never sends transactions.
For audit reading use each module's auditSourceFile, NOT an unvalidated build
adapter. The frontend's single-module view remains the canonical source view.
An actual negative test altered channel's expected friend to unexpected_friend:
build succeeded, but verify.mjs exited 1 with friendAclPassed=false and did not
run tests. This confirms that compiler success cannot bypass the ACL check.
