//! Read a saved exact-object GraphQL response on stdin; inspect the binary function
//! definitions and run the same fail-closed decompiler used by the API.
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use move_binary_format::file_format::CompiledModule;
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let response: serde_json::Value = serde_json::from_str(&input).unwrap();
    let nodes = response["data"]["object"]["package"]["modules"]["nodes"].as_array().unwrap();
    for node in nodes {
        let bytes = BASE64.decode(node["bytes"].as_str().unwrap()).unwrap();
        let module = CompiledModule::deserialize_with_defaults(&bytes).unwrap();
        let names: Vec<_> = module.function_defs.iter().map(|f| {
            module.identifier_at(module.function_handle_at(f.function).name).to_string()
        }).collect();
        eprintln!("{}: {} functions: {}", node["name"], names.len(), names.join(", "));
        match sui_scope_rust::decompile_verified_bytecode(&bytes) {
            Ok((source, verification)) => println!("RESULT {}", serde_json::json!({
                "name":node["name"], "source":source, "verification":verification
            })),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
    }
}
