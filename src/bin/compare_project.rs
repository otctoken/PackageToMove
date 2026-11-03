//! Compare original fixture bytes with rebuilt modules; no execution or transactions.
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use move_binary_format::{
    file_format::CompiledModule,
    normalized::{Module, RcPool},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

fn collect(path: &Path, out: &mut BTreeMap<String, (CompiledModule, Vec<u8>)>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_symlink() {
            panic!("Unexpected symlink");
        }
        if entry.file_type().unwrap().is_dir() {
            collect(&entry.path(), out);
        } else if entry.path().extension().is_some_and(|s| s == "mv") {
            let bytes = std::fs::read(entry.path()).unwrap();
            let m = CompiledModule::deserialize_with_defaults(&bytes).unwrap_or_else(|error| {
                // Decode only for diagnostics; NEVER accept unchecked output.
                let oversized: Vec<_> = CompiledModule::deserialize_no_check_bounds(&bytes)
                    .ok()
                    .map(|m| {
                        m.function_defs
                            .iter()
                            .filter_map(|f| {
                                let code = f.code.as_ref()?;
                                let handle = m.function_handle_at(f.function);
                                let count = m.signature_at(handle.parameters).len()
                                    + m.signature_at(code.locals).len();
                                (count > 255).then(|| {
                                    format!("{}: {count} locals", m.identifier_at(handle.name))
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                panic!(
                    "Invalid rebuilt module {}: {error:?}; {}",
                    entry.path().display(),
                    oversized.join(", ")
                );
            });
            let id = m.self_id().to_string();
            if let Some((_, previous)) = out.get(&id) {
                assert_eq!(previous, &bytes, "Conflicting rebuilt module identity");
            }
            out.insert(id, (m, bytes));
        }
    }
}
fn main() {
    let exact_required = std::env::args().any(|arg| arg == "--require-exact-bytecode");
    let args: Vec<_> = std::env::args()
        .filter(|arg| arg != "--require-exact-bytecode")
        .collect();
    assert!(
        (3..=4).contains(&args.len()),
        "compare_project <fixture.json> <build-directory> [report.json] [--require-exact-bytecode]"
    );
    let fixture: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    let mut compiled = BTreeMap::new();
    collect(Path::new(&args[2]), &mut compiled);
    let mut pool = RcPool::new();
    let mut functions = 0;
    let mut identical = 0;
    let mut modules = 0;
    let mut differences = vec![];
    let mut matched = 0;
    let mut empty_module_metadata_differences = vec![];
    let mut module_bytecode_differences = vec![];
    let mut raw_identical_modules = 0;
    for node in fixture["data"]["object"]["package"]["modules"]["nodes"]
        .as_array()
        .unwrap()
    {
        let bytes = BASE64.decode(node["bytes"].as_str().unwrap()).unwrap();
        let original = CompiledModule::deserialize_with_defaults(&bytes).unwrap();
        let (rebuilt, rebuilt_bytes) = compiled
            .get(&original.self_id().to_string())
            .expect("Missing rebuilt module");
        move_bytecode_verifier::verify_module_unmetered(&original)
            .expect("Original bytecode verification failed");
        move_bytecode_verifier::verify_module_unmetered(rebuilt)
            .expect("Rebuilt bytecode verification failed");
        // Same module criterion as MystenLabs sui-source-verification/compare.rs
        // at bf4073918ed33cfa0b09c500658fa116a774bcfd. This is an audit-address
        // comparison; dependency linkage and original toolchain are separate.
        raw_identical_modules += usize::from(bytes == *rebuilt_bytes);
        if original != *rebuilt {
            module_bytecode_differences.push(original.self_id().to_string());
        }
        let a = Module::new(&mut pool, &original, true);
        let b = Module::new(&mut pool, rebuilt, true);
        assert_eq!(a.id, b.id);
        let mut af = a.friends.clone();
        let mut bf = b.friends.clone();
        af.sort();
        bf.sort();
        if af != bf {
            let empty = |m: &CompiledModule| {
                m.function_defs.is_empty()
                    && m.struct_defs.is_empty()
                    && m.enum_defs.is_empty()
                    && m.constant_pool.is_empty()
            };
            assert!(
                empty(&original) && empty(rebuilt) && bf.is_empty(),
                "Friend ACL changed in a nonempty module"
            );
            empty_module_metadata_differences.push(serde_json::json!({"module":a.id.to_string(),"originalFriends":af.iter().map(ToString::to_string).collect::<Vec<_>>(),"compiledFriends":bf.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "scope":"Empty module only; no functions, types or constants. Exact metadata and upgrade compatibility are not verified."}));
        }
        assert_eq!(a.structs.len(), b.structs.len());
        assert_eq!(a.enums.len(), b.enums.len());
        for (name, s) in &a.structs {
            assert!(
                s.equivalent(b.structs.get(name).unwrap()),
                "Struct layout changed"
            );
        }
        for (name, e) in &a.enums {
            assert!(
                e.equivalent(b.enums.get(name).unwrap()),
                "Enum layout changed"
            );
        }
        assert_eq!(a.functions.len(), b.functions.len());
        for (name, f) in &a.functions {
            let g = b.functions.get(name).expect("Function removed");
            assert_eq!(f.visibility, g.visibility, "Visibility changed");
            assert_eq!(f.is_entry, g.is_entry, "Entry flag changed");
            assert_eq!(
                f.type_parameters, g.type_parameters,
                "Generic constraints changed"
            );
            assert_eq!(f.parameters, g.parameters, "Parameter types changed");
            assert_eq!(f.return_, g.return_, "Return types changed");
            functions += 1;
            identical += usize::from(f.equivalent(g));
            {
                let exact = f.equivalent(g);
                let comparison = if exact {
                    sui_scope_rust::body_compare::BodyComparison {
                        status: "normalized-identical",
                        paired_states: 0,
                        reason: "Normalized instructions, jump tables and function interface match"
                            .into(),
                    }
                } else {
                    sui_scope_rust::body_compare::compare(f, g)
                };
                matched += usize::from(comparison.status == "matched-under-model");
                differences.push(serde_json::json!({
                    "comparison":comparison,
                    "originalBytecodeSha256":format!("{:x}",Sha256::digest(&bytes)),
                    "rebuiltBytecodeSha256":format!("{:x}",Sha256::digest(rebuilt_bytes)),
                    "module":original.self_id().to_string(), "function":name.to_string(),
                    "originalLocals":format!("{:?}",f.locals), "rebuiltLocals":format!("{:?}",g.locals),
                    "original":if exact{vec![]}else{f.code().iter().map(|i|format!("{i:?}")).collect::<Vec<_>>()},
                    "rebuilt":if exact{vec![]}else{g.code().iter().map(|i|format!("{i:?}")).collect::<Vec<_>>()}
                }));
            }
        }
        modules += 1;
    }
    if let Some(path) = args.get(3) {
        std::fs::write(path, serde_json::to_vec_pretty(&differences).unwrap()).unwrap();
    }
    println!(
        "{}",
        serde_json::json!({"modules":modules,"functions":functions,
        "interfacesAndLayoutsMatch":true,"normalizedFunctionBodiesIdentical":identical,
        "friendTablesIdentical":empty_module_metadata_differences.is_empty(),
        "exactModuleBytecodeMatch":module_bytecode_differences.is_empty(),
        "exactModuleBytecodeDifferences":module_bytecode_differences,
        "rawBytecodeIdenticalModules":raw_identical_modules,
        "moduleComparisonCriterion":"CompiledModule equality; MystenLabs/sui bf4073918ed33cfa0b09c500658fa116a774bcfd",
        "linkageVerified":false,
        "emptyModuleMetadataDifferences":empty_module_metadata_differences,
        "additionalBodiesMatchedUnderModel":matched,
        "unverifiedBodies":functions-identical-matched,
        "instructionModel":"paired-instruction-v2-experimental",
        "instructionModelMatched":functions==identical+matched,
        "semanticEquivalenceProven":false})
    );
    if functions != identical + matched
        || (exact_required && !module_bytecode_differences.is_empty())
    {
        std::process::exit(1)
    }
}
