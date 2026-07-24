// Copyright (c) 2026 SuiScope contributors
// SPDX-License-Identifier: MIT

use move_binary_format::file_format::{Bytecode, CompiledModule};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::TempDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BytecodeVerification {
    pub canonical_input: &'static str,
    pub bytecode_sha256: String,
    pub bytecode_size: usize,
    pub bytecode_verified: bool,
    pub source_view_generated: bool,
    pub function_count: usize,
    pub instruction_count: usize,
    pub constant_count: usize,
    pub abort_count: usize,
    pub branch_count: usize,
    pub backward_branch_count: usize,
    pub generic_call_count: usize,
    pub write_ref_count: usize,
}

fn inspect_bytecode(module: &CompiledModule, bytecode: &[u8]) -> BytecodeVerification {
    let mut instruction_count = 0;
    let mut abort_count = 0;
    let mut branch_count = 0;
    let mut backward_branch_count = 0;
    let mut generic_call_count = 0;
    let mut write_ref_count = 0;

    for definition in module.function_defs() {
        let Some(code) = &definition.code else {
            continue;
        };
        instruction_count += code.code.len();
        for (offset, instruction) in code.code.iter().enumerate() {
            match instruction {
                Bytecode::Abort => abort_count += 1,
                Bytecode::Branch(target)
                | Bytecode::BrTrue(target)
                | Bytecode::BrFalse(target) => {
                    branch_count += 1;
                    if usize::from(*target) <= offset {
                        backward_branch_count += 1;
                    }
                }
                Bytecode::CallGeneric(_) => generic_call_count += 1,
                Bytecode::WriteRef => write_ref_count += 1,
                _ => {}
            }
        }
    }

    BytecodeVerification {
        canonical_input: "sui-chain-bytecode",
        bytecode_sha256: format!("{:x}", Sha256::digest(bytecode)),
        bytecode_size: bytecode.len(),
        bytecode_verified: true,
        source_view_generated: true,
        function_count: module.function_defs().len(),
        instruction_count,
        constant_count: module.constant_pool().len(),
        abort_count,
        branch_count,
        backward_branch_count,
        generic_call_count,
        write_ref_count,
    }
}

/// Turns verified Move bytecode into a readable source view.
///
/// The bytecode remains canonical. The generated text is not claimed to be the
/// publisher's original source and is never fed through an AI rewriting step.
pub fn decompile_verified_bytecode(
    bytecode: &[u8],
) -> Result<(String, BytecodeVerification), String> {
    let module = CompiledModule::deserialize_with_defaults(bytecode)
        .map_err(|error| format!("Move bytecode parse failed: {error}"))?;
    move_bytecode_verifier::verify_module_unmetered(&module)
        .map_err(|error| format!("Move bytecode verification failed: {error}"))?;

    let workspace =
        TempDir::new().map_err(|error| format!("Could not create temporary directory: {error}"))?;
    let input = workspace.path().join("module.mv");
    let output = workspace.path().join("output");
    fs::write(&input, bytecode)
        .map_err(|error| format!("Could not stage Move bytecode: {error}"))?;
    let paths = move_decompiler::generate_from_files(&[input], &output)
        .map_err(|error| format!("Rust Move decompiler failed: {error}"))?;
    let source_path = paths
        .first()
        .ok_or_else(|| "Rust Move decompiler produced no source view".to_owned())?;
    let source = fs::read_to_string(source_path)
        .map_err(|error| format!("Could not read generated Move source view: {error}"))?;
    Ok((source, inspect_bytecode(&module, bytecode)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

    const RANGE_MODULE: &[u8] =
        include_bytes!("../vendor/move-decompiler-zig/src/test_data/range.mv");
    const TREASURY_MODULE: &str = "oRzrCwYAAAAKAQAOAg4oAzZNBIMBDgWRAZMBB6QClAIIuARgBpgFXgr2BQUM+wVeABsBCAETAgoCGgIcAh0ABAIAAQMHAAICBwEAAAMADAEAAQMBDAEAAQMFDAEAAQUGAgAGBwcAABAAAQAADgIDAAAPBAEAAAwFAQAAFAEGAAEZCAkAAhgLDAEAAwkUFQEAAwsODwECAxEREgEABBULAQEMBBYLAQEMBBcTAQEMBhIJCgAGCggNCxAKBwkNDAMHDQIIAAcIBgADBwsFAQgAAwcIBgELAwEIAAQHCwUBCAADBQcIBgIHCwUBCAALAwEIAAECAQsEAQgAAQoCAQgBAQgHAQkAAQsCAQkAAQgABwkAAgoCCgIKAgsCAQgHBwgGAgsFAQkACwQBCQABCwUBCAADBwsFAQkAAwcIBgELAwEJAAIJAAUCBwsFAQkACwMBCQABAwRDb2luDENvaW5NZXRhZGF0YQZPcHRpb24GU3RyaW5nCFRSRUFTVVJZC1RyZWFzdXJ5Q2FwCVR4Q29udGV4dANVcmwFYXNjaWkEYnVybgRjb2luD2NyZWF0ZV9jdXJyZW5jeQdkZXN0cm95C2R1bW15X2ZpZWxkBWdyYW50CGdyYW50X3RvBGluaXQEbWludApuZXdfdW5zYWZlBm9wdGlvbgtwcm90b2NvbF9pZBRwdWJsaWNfZnJlZXplX29iamVjdBNwdWJsaWNfc2hhcmVfb2JqZWN0D3B1YmxpY190cmFuc2ZlcgRzb21lBnN0cmluZwh0cmFuc2Zlcgh0cmVhc3VyeQp0eF9jb250ZXh0A3VybNdNqyRrDb01CZJI/dH6u8RMFdbuks2pvcJDNiO1GbNuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMIZAAAAAAAAAAKAgUEV1dBTAoCDAtXcmFwcGVkIFdBTAoCAQAKAjY1aHR0cHM6Ly9pbWd1cmx6eC5jb20vdG9rZW4taW1hZ2UvdG9rZW4tdFJVR2stcE5BXy5zdmcAAgENAQAAAAAHEAsAMQkHAQcCBwMHBBEFEQ04AAsBOAEMAjgCCwI4AwIBAQAAAQULAAsBCwI4BAICAQQAAQcLAAsBCwM4BAsCOAUCAwEEAAEFCwALATgGAQIEAQAAAQIxAQIA";

    #[test]
    fn range_fixture_is_verified_and_decompiled_from_exact_bytecode() {
        let (source, verification) =
            decompile_verified_bytecode(RANGE_MODULE).expect("range fixture must decompile");
        assert_eq!(
            verification.bytecode_sha256,
            "01fcc922e020212d6d152ed7b00501569efe5c344c2f2f685799d96479414326"
        );
        assert!(verification.bytecode_verified);
        assert!(verification.source_view_generated);
        assert!(verification.function_count >= 10);
        assert!(verification.instruction_count > 100);
        assert!(verification.abort_count > 0);
        assert!(verification.branch_count > 0);
        assert!(verification.generic_call_count > 0);
        assert!(verification.write_ref_count > 0);
        assert!(source.contains("fun play_internal"));
        // The decompiler recovers the bytecode's conditional Abort pattern as
        // Move's source-level assert! macro.
        assert!(source.contains("assert!"));
        assert!(source.contains("loop {"));
        assert!(source.contains("*(&mut l14.min_stake) = l1"));
        assert!(source.contains("event::emit(RangeParametersSetEvent"));
        assert!(source.contains("is_new: !(l12)"));
        assert!(source.contains("type_name::with_defining_ids<T0>()"));
        assert!(source.contains("core::assert_is_manager<Range>"));
        assert!(
            source.contains(
                "dynamic_object_field::exists_with_type<TypeName, Parameters<T0>>"
            )
        );
        assert!(source.contains("event::emit<RangeParametersSetEvent<T0>>"));
    }

    #[test]
    fn discarded_burn_result_keeps_the_effectful_call() {
        let bytecode = BASE64
            .decode(TREASURY_MODULE)
            .expect("on-chain treasury module fixture must be valid base64");
        let (source, verification) =
            decompile_verified_bytecode(&bytecode).expect("treasury fixture must decompile");

        assert!(verification.bytecode_verified);
        assert_eq!(verification.function_count, 5);
        assert!(
            source.contains("coin::burn<TREASURY>(l0, l1)"),
            "destroy must retain its effectful burn call:\n{source}"
        );
        assert!(
            !source.contains("public entry fun destroy(l0: &mut TreasuryCap<TREASURY>, l1: Coin<TREASURY>) {}"),
            "destroy must not be rendered with an empty body:\n{source}"
        );
    }
}
