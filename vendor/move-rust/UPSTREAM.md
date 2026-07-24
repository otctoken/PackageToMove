# Upstream provenance

The Rust Move bytecode parser, verifier, model, stackless bytecode pipeline,
and decompiler in this directory are vendored from:

- Repository: `https://github.com/MystenLabs/sui`
- Commit: `26c78168d2be95e0686b8a604b3ad0ec763829c2`
- Source root: `external-crates/move`
- License: Apache-2.0 (see `LICENSE`)

Only the transitive crate closure needed by `move-decompiler` is included.
Upstream tests, benchmarks, and snapshots were omitted from the deployment
vendor tree. `move-regex-borrow-graph::tests` and
`move-package-alt::test_utils` are gated with `cfg(test)` because those omitted
public test modules are not part of the production dependency graph.

The application configures the upstream decompiler with its default
non-optimizing bytecode-to-stackless pipeline. No AI or source-rewriting pass
is applied.
