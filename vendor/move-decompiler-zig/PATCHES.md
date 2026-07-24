# Local CFG and source-recovery patches

Upstream: `unconfirmedlabs/move-decompiler-zig` at
`bb699931141086521e492d172b7c6d5591759498`.

## Why this fork exists

The upstream single-pass region structurer treated every jump to a
non-immediately-dominated target inside a loop as `break`. In compiled Move,
both arms of an `if` commonly jump to a shared continuation block. That join
edge is not a loop exit.

The failure produced source like:

```move
if (condition) {
    value = left;
    break;
} else {
    value = right;
    break;
}
use(value); // incorrectly unreachable
```

## Changes

- Bound branch arms at their nearest common reachable continuation.
- Traverse forward join edges as sequential control flow.
- Emit `break` only when a target actually leaves the current natural loop.
- Use independent visited sets for sibling branch arms.
- Add a synthetic CFG regression test proving that an in-loop diamond join
  contains no `break`.

The application-level refinement in `lib/wasm-decompiler.ts` additionally:

- lifts abort-only arms into `assert!`;
- merges branch-local assignments into Move `if` expressions;
- restores explicit return values after terminating arms are lifted;
- expands module addresses using the chain-provided disassembly.

The raw Bytecode IR remains the source of truth for irreducible or unsupported
control flow.
