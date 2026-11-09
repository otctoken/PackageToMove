# Vector instruction restoration and the 28-function review

## Result (2026-11-09)

The `0xfed8f891e64a8bd76c30eac4694611f63f7ba151c5d0eb19de67d7b9b24de395`
fixture contains 37 modules / 628 functions. After this correction, the unchanged
`paired-instruction-v2-experimental` comparator reports:

| Criterion | Result |
| --- | --- |
| Normalized function instructions identical | 426 |
| Additional functions matched under the paired-path model | 202 |
| Unverified functions | **0** |
| Function interfaces and struct/enum layouts | All 37 modules match |
| Friend permission tables | All 37 modules match |
| Audit / new-package build and verification | Both pass |
| Whole module bytes identical | 0/37 |
| Complete VM semantic equivalence proven | **No** |

The 28 previously unverified functions are now 7 normalized-identical and 21
matched under the existing model. This is a bounded translation-validation result,
not a claim of identical gas, original compiler environment, historical dependency
implementations or new-package type identity. No author business tests were recovered.

## Official source and chain evidence

Inspected official MystenLabs/Sui revision `bf4073918ed33cfa0b09c500658fa116a774bcfd`:

- [vector.move](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/crates/sui-framework/packages/move-stdlib/sources/vector.move): the vector primitive declarations carry `#[bytecode_instruction]`.
- [fake_natives.rs](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/external-crates/move/crates/move-compiler/src/naming/fake_natives.rs): `resolve_builtin` actually matches the **named** address `std`. Its adjacent comment also mentions numeric `0x1`, but the implementation does not handle that case.
- [to_bytecode/translate.rs](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/external-crates/move/crates/move-compiler/src/to_bytecode/translate.rs): `module_call` emits `Vec*` when the builtin resolves, otherwise a normal `Call`.
- [VM vector natives](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/external-crates/move/crates/move-vm-runtime/src/natives/move_stdlib/vector.rs) and [VM instruction evaluation](https://github.com/MystenLabs/sui/blob/bf4073918ed33cfa0b09c500658fa116a774bcfd/external-crates/move/crates/move-vm-runtime/src/execution/interpreter/eval.rs): vector data operations share `Vector`/`VectorRef` primitives, but native calls have their own gas charging and native error conversion. They must not be accepted as identical instructions merely by function name.

Read mainnet `0x1::vector` directly through GraphQL: package version 26,
digest `EYncsUuNMEpL7HcuibF15GgurLysZLBYXn8vjUsYc6MB`, module SHA-256
`2de382f35b83bb8681d149be3112797e027d70be0972f4092d98b1889c799b06`.
It contains native `length`, `borrow`, `borrow_mut`, `push_back`, `pop_back`,
`destroy_empty`, and `swap`. A native declaration alone is not evidence of opcode
equivalence. The application comparison uses the attachment's original module bytes;
the final production check also re-fetches and compares their hashes.

## Corrections without changing acceptance rules

1. The legacy renderer used `0x1::vector::...` for original `Vec*` instructions.
   This compiled successfully but produced ordinary calls. Render `std::vector::...`
   instead, restoring the actual vector opcodes, generic types, operands and order.
   Original call instructions and user-defined modules named `vector` are not rewritten.
2. After the vector fix, `pool::calculate_swap_results` exposed a further difference:
   the original branches on `amount_specified_remaining > 0`, selects `true` or
   `false`, then writes `SwapResult.is_exceed`. A refinement replaced that selection
   with the predicate value. Retain both-literal conditional arms generically so
   the reconstructed source keeps the original branch and selected value. No
   comparison rule was added to treat the two forms as interchangeable.

No module/function allowlist, no skipped paths, no Call-to-Vec normalization,
no relaxed constant/reference/state-write comparison, and no friend exception.
The numeric-address-call defect is reproduced as a negative regression and remains rejected.

## The 28 reviewed functions

| Module | Functions | Result |
| --- | --- | --- |
| config | remove_reward_manager, set_reward_manager, verify_reward_manager | Model match |
| oracle | initialize_manager, get_surrounding_observations, update, grow | Model match |
| oracle | observations_length, get_observation | Normalized identical |
| pool | add_reward_info, update_pool_reward_emission, update_reward_infos, calculate_swap_results, is_reward_present, find_reward_info_index, get_accrued_rewards, create_pool_internal | Model match |
| pool | reward_infos_length | Normalized identical |
| position | init, is_empty, update_reward_infos | Model match |
| position | coins_owed_reward, reward_infos_length, add_reward_info, get_mutable_reward_info | Normalized identical |
| tick | update, fetch_provided_ticks, compute_reward_growths | Model match |

All belong to original bytecode address
`0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267`.
Names identify evidence only; the implementation does not match these names.

## Reproduction and regression gates

```sh
cargo build --bin verify_package --bin compare_project
npm run test:friend-events-roundtrip -- .research/vector-events
npx tsx scripts/test-vector-intrinsics.ts .research/vector-intrinsics
```

The complete 628-function comparison is now mandatory in Linux CI, replacing the
previous build-only events check. The synthetic regression compiles and decompiles
all eight vector opcode families with generic element types and explicit friend
permissions. Original native calls and a user module named `vector` must stay calls.
Its successful baseline must compare with zero unverified functions.
Three independently compilable mutations must be rejected: a changed borrow index,
ordinary numeric-address native calls, and an inverted boolean state write.
Existing optimizer/efbfd/math instruction regressions, authority builds, exact friend
removal-negative testing, and the refusal to certify non-identical whole-module
bytecode remain enabled.
