// Copyright (c) 2026 SuiScope contributors
// SPDX-License-Identifier: MIT

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use move_binary_format::file_format::{Bytecode, CompiledModule};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::TempDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BytecodeVerification {
    pub canonical_input: &'static str,
    pub audit_policy: &'static str,
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
    pub known_instruction_coverage: bool,
    pub control_flow_fully_structured: bool,
    pub audit_warnings: Vec<String>,
}

#[derive(Deserialize)]
struct GraphQlEnvelope {
    data: Option<GraphQlData>,
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Deserialize)]
struct GraphQlData {
    package: Option<GraphQlPackage>,
}

#[derive(Deserialize)]
struct GraphQlPackage {
    module: Option<GraphQlModule>,
    #[serde(default)]
    linkage: Value,
}

#[derive(Deserialize)]
struct GraphQlModule {
    name: String,
    bytes: Option<String>,
}

#[derive(Deserialize)]
struct GraphQlError {
    message: String,
}

pub fn decode_graphql_module_response(
    response: Value,
    expected_module: &str,
) -> Result<(Vec<u8>, Value), String> {
    let response: GraphQlEnvelope = serde_json::from_value(response)
        .map_err(|error| format!("Invalid Sui GraphQL response: {error}"))?;
    if let Some(error) = response.errors.and_then(|errors| errors.into_iter().next()) {
        return Err(format!("Sui GraphQL error: {}", error.message));
    }
    let package = response
        .data
        .and_then(|data| data.package)
        .ok_or_else(|| "Address is not a Move package or does not exist".to_owned())?;
    let module = package
        .module
        .ok_or_else(|| format!("Package does not contain module {expected_module}"))?;
    if module.name != expected_module {
        return Err("Sui GraphQL returned an unexpected module".to_owned());
    }
    let encoded = module
        .bytes
        .ok_or_else(|| "Sui GraphQL did not return module bytecode".to_owned())?;
    let bytecode = BASE64
        .decode(encoded)
        .map_err(|error| format!("Invalid module bytecode: {error}"))?;
    Ok((bytecode, package.linkage))
}

fn rendered_call_counts(source: &str) -> (usize, usize) {
    let bytes = source.as_bytes();
    let mut call_count = 0;
    let mut generic_call_count = 0;
    let mut cursor = 0;

    while cursor + 1 < bytes.len() {
        if bytes[cursor] != b':' || bytes[cursor + 1] != b':' {
            cursor += 1;
            continue;
        }

        let mut end = cursor + 2;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        if end == cursor + 2 {
            cursor += 2;
            continue;
        }

        let mut next = end;
        let mut generic = false;
        if next < bytes.len() && bytes[next] == b'<' {
            generic = true;
            let mut depth = 0usize;
            while next < bytes.len() {
                match bytes[next] {
                    b'<' => depth += 1,
                    b'>' => {
                        depth -= 1;
                        if depth == 0 {
                            next += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                next += 1;
            }
        }
        while next < bytes.len() && bytes[next].is_ascii_whitespace() {
            next += 1;
        }
        if next < bytes.len() && bytes[next] == b'(' {
            call_count += 1;
            generic_call_count += usize::from(generic);
        }
        cursor = end;
    }

    (call_count, generic_call_count)
}

fn rendered_function_sections(source: &str) -> (usize, String) {
    let source = source
        .lines()
        .map(|line| line.split_once("//").map_or(line, |(code, _)| code))
        .collect::<Vec<_>>()
        .join("\n");
    let bytes = source.as_bytes();
    let is_identifier_byte = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut function_count = 0;
    let mut bodies = String::new();
    let mut cursor = 0;

    while cursor + 3 <= bytes.len() {
        let Some(relative) = source[cursor..].find("fun") else {
            break;
        };
        let start = cursor + relative;
        let before_is_identifier = start > 0 && is_identifier_byte(bytes[start - 1]);
        let after_is_identifier = start + 3 < bytes.len() && is_identifier_byte(bytes[start + 3]);
        if before_is_identifier || after_is_identifier {
            cursor = start + 3;
            continue;
        }

        function_count += 1;
        let mut signature_end = start + 3;
        while signature_end < bytes.len()
            && bytes[signature_end] != b'{'
            && bytes[signature_end] != b';'
        {
            signature_end += 1;
        }
        if signature_end == bytes.len() || bytes[signature_end] == b';' {
            cursor = signature_end.saturating_add(1);
            continue;
        }

        let body_start = signature_end + 1;
        let mut depth = 1usize;
        let mut body_end = body_start;
        while body_end < bytes.len() && depth > 0 {
            match bytes[body_end] {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            body_end += 1;
        }
        if depth != 0 {
            break;
        }
        bodies.push_str(&source[body_start..body_end - 1]);
        bodies.push('\n');
        cursor = body_end;
    }

    (function_count, bodies)
}

fn inspect_bytecode(
    module: &CompiledModule,
    bytecode: &[u8],
    source: &str,
) -> BytecodeVerification {
    let mut instruction_count = 0;
    let mut abort_count = 0;
    let mut branch_count = 0;
    let mut backward_branch_count = 0;
    let mut call_count = 0;
    let mut generic_call_count = 0;
    let mut write_ref_count = 0;
    let mut freeze_ref_count = 0;
    let mut arithmetic_count = 0;
    let mut comparison_count = 0;
    let mut cast_count = 0;
    let mut unsupported_instruction_count = 0;

    for definition in module.function_defs() {
        let Some(code) = &definition.code else {
            continue;
        };
        instruction_count += code.code.len();
        for (offset, instruction) in code.code.iter().enumerate() {
            match instruction {
                Bytecode::Abort => abort_count += 1,
                Bytecode::Branch(target) | Bytecode::BrTrue(target) | Bytecode::BrFalse(target) => {
                    branch_count += 1;
                    if usize::from(*target) <= offset {
                        backward_branch_count += 1;
                    }
                }
                Bytecode::Call(_) => call_count += 1,
                Bytecode::CallGeneric(_) => {
                    call_count += 1;
                    generic_call_count += 1;
                }
                Bytecode::WriteRef => write_ref_count += 1,
                Bytecode::FreezeRef => freeze_ref_count += 1,
                Bytecode::Add
                | Bytecode::Sub
                | Bytecode::Mul
                | Bytecode::Div
                | Bytecode::Mod
                | Bytecode::Shl
                | Bytecode::Shr
                | Bytecode::BitOr
                | Bytecode::BitAnd
                | Bytecode::Xor => arithmetic_count += 1,
                Bytecode::Eq
                | Bytecode::Neq
                | Bytecode::Lt
                | Bytecode::Gt
                | Bytecode::Le
                | Bytecode::Ge => comparison_count += 1,
                Bytecode::CastU8
                | Bytecode::CastU16
                | Bytecode::CastU32
                | Bytecode::CastU64
                | Bytecode::CastU128
                | Bytecode::CastU256 => cast_count += 1,
                Bytecode::MutBorrowGlobalDeprecated(_)
                | Bytecode::ImmBorrowGlobalDeprecated(_)
                | Bytecode::ExistsDeprecated(_)
                | Bytecode::MoveFromDeprecated(_)
                | Bytecode::MoveToDeprecated(_) => unsupported_instruction_count += 1,
                _ => {}
            }
        }
    }

    let (rendered_function_count, rendered_bodies) = rendered_function_sections(source);
    let (rendered_call_count, rendered_generic_call_count) = rendered_call_counts(&rendered_bodies);
    let rendered_abort_count =
        rendered_bodies.matches("abort ").count() + rendered_bodies.matches("assert!(").count();
    let rendered_write_ref_count = rendered_bodies
        .lines()
        .filter(|line| {
            let line = line.trim_start();
            line.starts_with('*') && line.contains(" = ")
        })
        .count();
    let rendered_freeze_ref_count = rendered_bodies.matches("freeze(").count();
    let rendered_arithmetic_count = [
        " + ", " - ", " * ", " / ", " % ", " << ", " >> ", " | ", " & ", " ^ ",
    ]
    .iter()
    .map(|operator| rendered_bodies.matches(operator).count())
    .sum::<usize>();
    let rendered_comparison_count = [" == ", " != ", " < ", " > ", " <= ", " >= "]
        .iter()
        .map(|operator| rendered_bodies.matches(operator).count())
        .sum::<usize>();
    let rendered_cast_count = [
        " as u8", " as u16", " as u32", " as u64", " as u128", " as u256",
    ]
    .iter()
    .map(|cast| rendered_bodies.matches(cast).count())
    .sum::<usize>();

    let mut audit_warnings = Vec::new();
    let coverage_checks = [
        (
            "function",
            module.function_defs().len(),
            rendered_function_count,
        ),
        ("call", call_count, rendered_call_count),
        (
            "generic call",
            generic_call_count,
            rendered_generic_call_count,
        ),
        ("abort", abort_count, rendered_abort_count),
        ("WriteRef", write_ref_count, rendered_write_ref_count),
        ("FreezeRef", freeze_ref_count, rendered_freeze_ref_count),
        ("arithmetic", arithmetic_count, rendered_arithmetic_count),
        ("comparison", comparison_count, rendered_comparison_count),
        ("cast", cast_count, rendered_cast_count),
    ];
    for (kind, bytecode_count, source_count) in coverage_checks {
        if bytecode_count != source_count {
            audit_warnings.push(format!(
                "{kind} coverage mismatch: bytecode has {bytecode_count}, source view has {source_count}"
            ));
        }
    }
    if unsupported_instruction_count > 0 {
        audit_warnings.push(format!(
            "{unsupported_instruction_count} deprecated global-storage bytecode instructions are unsupported"
        ));
    }
    let control_flow_fully_structured =
        !source.contains("Did not structure and emit blocks") && !source.contains("goto 'label_");
    if !control_flow_fully_structured {
        audit_warnings.push(
            "Control flow contains unstructured or omitted blocks; use Bytecode IR for audit"
                .to_owned(),
        );
    }
    let known_instruction_coverage =
        unsupported_instruction_count == 0 && audit_warnings.is_empty();

    BytecodeVerification {
        canonical_input: "sui-chain-bytecode",
        audit_policy: "fail-closed-v1",
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
        known_instruction_coverage,
        control_flow_fully_structured,
        audit_warnings,
    }
}

fn enforce_audit_policy(
    source: String,
    verification: BytecodeVerification,
) -> Result<(String, BytecodeVerification), String> {
    if !verification.known_instruction_coverage
        || !verification.control_flow_fully_structured
        || !verification.audit_warnings.is_empty()
    {
        return Err(format!(
            "AUDIT_UNSAFE: decompilation rejected by {} policy: {}",
            verification.audit_policy,
            verification.audit_warnings.join("; ")
        ));
    }
    Ok((source, verification))
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
    let verification = inspect_bytecode(&module, bytecode, &source);
    enforce_audit_policy(source, verification)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RANGE_MODULE: &[u8] =
        include_bytes!("../vendor/move-decompiler-zig/src/test_data/range.mv");
    const TREASURY_MODULE: &str = "oRzrCwYAAAAKAQAOAg4oAzZNBIMBDgWRAZMBB6QClAIIuARgBpgFXgr2BQUM+wVeABsBCAETAgoCGgIcAh0ABAIAAQMHAAICBwEAAAMADAEAAQMBDAEAAQMFDAEAAQUGAgAGBwcAABAAAQAADgIDAAAPBAEAAAwFAQAAFAEGAAEZCAkAAhgLDAEAAwkUFQEAAwsODwECAxEREgEABBULAQEMBBYLAQEMBBcTAQEMBhIJCgAGCggNCxAKBwkNDAMHDQIIAAcIBgADBwsFAQgAAwcIBgELAwEIAAQHCwUBCAADBQcIBgIHCwUBCAALAwEIAAECAQsEAQgAAQoCAQgBAQgHAQkAAQsCAQkAAQgABwkAAgoCCgIKAgsCAQgHBwgGAgsFAQkACwQBCQABCwUBCAADBwsFAQkAAwcIBgELAwEJAAIJAAUCBwsFAQkACwMBCQABAwRDb2luDENvaW5NZXRhZGF0YQZPcHRpb24GU3RyaW5nCFRSRUFTVVJZC1RyZWFzdXJ5Q2FwCVR4Q29udGV4dANVcmwFYXNjaWkEYnVybgRjb2luD2NyZWF0ZV9jdXJyZW5jeQdkZXN0cm95C2R1bW15X2ZpZWxkBWdyYW50CGdyYW50X3RvBGluaXQEbWludApuZXdfdW5zYWZlBm9wdGlvbgtwcm90b2NvbF9pZBRwdWJsaWNfZnJlZXplX29iamVjdBNwdWJsaWNfc2hhcmVfb2JqZWN0D3B1YmxpY190cmFuc2ZlcgRzb21lBnN0cmluZwh0cmFuc2Zlcgh0cmVhc3VyeQp0eF9jb250ZXh0A3VybNdNqyRrDb01CZJI/dH6u8RMFdbuks2pvcJDNiO1GbNuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMIZAAAAAAAAAAKAgUEV1dBTAoCDAtXcmFwcGVkIFdBTAoCAQAKAjY1aHR0cHM6Ly9pbWd1cmx6eC5jb20vdG9rZW4taW1hZ2UvdG9rZW4tdFJVR2stcE5BXy5zdmcAAgENAQAAAAAHEAsAMQkHAQcCBwMHBBEFEQ04AAsBOAEMAjgCCwI4AwIBAQAAAQULAAsBCwI4BAICAQQAAQcLAAsBCwM4BAsCOAUCAwEEAAEFCwALATgGAQIEAQAAAQIxAQIA";

    #[test]
    fn rendered_call_counter_handles_nested_generic_arguments() {
        let source = r#"
            module 0x1::m;
            use 0x2::dynamic_object_field;
            fun f<T0>() {
                dynamic_object_field::exists_with_type<TypeName, Parameters<vector<T0>>>(
                    &l0.id,
                    l1
                );
                m::plain_call()
            }
        "#;

        assert_eq!(rendered_call_counts(source), (2, 1));
    }

    #[test]
    fn graphql_module_response_preserves_exact_bytes_and_linkage() {
        let response = json!({
            "data": {
                "package": {
                    "module": {
                        "name": "math",
                        "bytes": "AQIDBA=="
                    },
                    "linkage": [{
                        "originalId": "0x1",
                        "upgradedId": "0x1",
                        "version": 25
                    }]
                }
            }
        });

        let (bytes, linkage) =
            decode_graphql_module_response(response, "math").expect("response must decode");
        assert_eq!(bytes, [1, 2, 3, 4]);
        assert_eq!(linkage[0]["version"], 25);
    }

    #[test]
    fn graphql_errors_fail_closed_before_decompilation() {
        let response = json!({
            "data": null,
            "errors": [{ "message": "upstream unavailable" }]
        });

        let error = decode_graphql_module_response(response, "math")
            .expect_err("GraphQL errors must not produce bytecode");
        assert_eq!(error, "Sui GraphQL error: upstream unavailable");
    }

    #[test]
    fn range_fixture_is_verified_and_decompiled_from_exact_bytecode() {
        let (source, verification) =
            decompile_verified_bytecode(RANGE_MODULE).expect("range fixture must decompile");
        assert_eq!(
            verification.bytecode_sha256,
            "01fcc922e020212d6d152ed7b00501569efe5c344c2f2f685799d96479414326"
        );
        assert!(verification.bytecode_verified);
        assert_eq!(verification.audit_policy, "fail-closed-v1");
        assert!(verification.source_view_generated);
        assert!(verification.known_instruction_coverage);
        assert!(verification.control_flow_fully_structured);
        assert!(verification.audit_warnings.is_empty());
        assert!(verification.function_count >= 10);
        assert!(verification.instruction_count > 100);
        assert!(verification.abort_count > 0);
        assert!(verification.branch_count > 0);
        assert!(verification.generic_call_count > 0);
        assert!(verification.write_ref_count > 0);
        assert!(source.contains("fun play_internal"));
        // Conditional aborts must remain visible even when the structurer keeps them as
        // explicit `if (...) { abort ... }` blocks instead of recovering `assert!`.
        assert!(source.contains("abort 13836748378316996621u64"));
        assert!(source.contains("loop {"));
        assert!(source.contains("*(&mut l14.min_stake) = l1"));
        assert!(source.contains("is_new: !(l12)"));
        assert!(source.contains("type_name::with_defining_ids<T0>()"));
        assert!(source.contains("core::assert_is_manager<Range>"));
        assert!(
            source.contains("dynamic_object_field::exists_with_type<TypeName, Parameters<T0>>")
        );
        assert!(source.contains("event::emit<RangeParametersSetEvent<T0>>"));
    }

    #[test]
    fn audit_policy_rejects_incomplete_output_instead_of_returning_source() {
        let (source, mut verification) =
            decompile_verified_bytecode(RANGE_MODULE).expect("range fixture must decompile");
        verification.known_instruction_coverage = false;
        verification
            .audit_warnings
            .push("synthetic coverage regression".to_owned());

        let error = enforce_audit_policy(source, verification)
            .expect_err("incomplete output must fail closed");
        assert!(error.starts_with("AUDIT_UNSAFE:"));
        assert!(error.contains("synthetic coverage regression"));
    }

    #[test]
    fn discarded_burn_result_keeps_the_effectful_call() {
        let bytecode = BASE64
            .decode(TREASURY_MODULE)
            .expect("on-chain treasury module fixture must be valid base64");
        let (source, verification) =
            decompile_verified_bytecode(&bytecode).expect("treasury fixture must decompile");

        assert!(verification.bytecode_verified);
        assert_eq!(verification.audit_policy, "fail-closed-v1");
        assert!(verification.known_instruction_coverage);
        assert!(verification.control_flow_fully_structured);
        assert!(verification.audit_warnings.is_empty());
        assert_eq!(verification.function_count, 5);
        assert!(
            source.contains("coin::burn<TREASURY>(l0, l1)"),
            "destroy must retain its effectful burn call:\n{source}"
        );
        assert!(
            !source.contains(
                "public entry fun destroy(l0: &mut TreasuryCap<TREASURY>, l1: Coin<TREASURY>) {}"
            ),
            "destroy must not be rendered with an empty body:\n{source}"
        );
    }

    #[test]
    fn coverage_scanner_handles_friend_assert_write_ref_and_ability_syntax() {
        let source = r#"
            module 0x1::coverage;

            public(friend) fun version(): u64 {
                return 1u64
            }

            public(friend) entry fun update<T: key + store>(target: &mut u64, value: u64) {
                assert!(value > 0u64, 7u64);
                *target = value;
                *(table::borrow_mut<u64, u64>(&mut table, value)) = value + 1u64
            }
        "#;

        let (function_count, bodies) = rendered_function_sections(source);
        assert_eq!(function_count, 2);
        assert_eq!(bodies.matches("assert!(").count(), 1);
        assert_eq!(
            bodies
                .lines()
                .filter(|line| line.trim_start().starts_with('*') && line.contains(" = "))
                .count(),
            2
        );
        assert_eq!(
            bodies.matches(" + ").count(),
            1,
            "the `key + store` ability constraint is outside the function body"
        );
    }
}
