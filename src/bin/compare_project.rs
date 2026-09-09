//! Compare original fixture bytes with rebuilt modules; no execution or transactions.
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use move_binary_format::{file_format::CompiledModule, normalized::{Module, RcPool}};
use std::{collections::BTreeMap, path::Path};

fn collect(path: &Path, out: &mut BTreeMap<String, CompiledModule>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_symlink() { panic!("Unexpected symlink"); }
        if entry.file_type().unwrap().is_dir() { collect(&entry.path(), out); }
        else if entry.path().extension().is_some_and(|s| s == "mv") {
            let m = CompiledModule::deserialize_with_defaults(&std::fs::read(entry.path()).unwrap()).unwrap();
            out.insert(m.self_id().to_string(), m);
        }
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 3, "compare_project <fixture.json> <build-directory>");
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    let mut compiled = BTreeMap::new(); collect(Path::new(&args[2]), &mut compiled);
    let mut pool = RcPool::new();
    let mut functions = 0; let mut identical = 0; let mut modules = 0;
    for node in fixture["data"]["object"]["package"]["modules"]["nodes"].as_array().unwrap() {
        let bytes = BASE64.decode(node["bytes"].as_str().unwrap()).unwrap();
        let original = CompiledModule::deserialize_with_defaults(&bytes).unwrap();
        let rebuilt = compiled.get(&original.self_id().to_string()).expect("Missing rebuilt module");
        let a = Module::new(&mut pool, &original, true);
        let b = Module::new(&mut pool, rebuilt, true);
        assert_eq!(a.id, b.id);
        assert_eq!(a.structs.len(), b.structs.len());
        assert_eq!(a.enums.len(), b.enums.len());
        for (name, s) in &a.structs { assert!(s.equivalent(b.structs.get(name).unwrap()), "Struct layout changed"); }
        for (name, e) in &a.enums { assert!(e.equivalent(b.enums.get(name).unwrap()), "Enum layout changed"); }
        assert_eq!(a.functions.len(), b.functions.len());
        for (name, f) in &a.functions {
            let g = b.functions.get(name).expect("Function removed");
            assert_eq!(f.visibility, g.visibility, "Visibility changed");
            assert_eq!(f.is_entry, g.is_entry, "Entry flag changed");
            assert_eq!(f.type_parameters, g.type_parameters, "Generic constraints changed");
            assert_eq!(f.parameters, g.parameters, "Parameter types changed");
            assert_eq!(f.return_, g.return_, "Return types changed");
            functions += 1; identical += usize::from(f.equivalent(g));
        }
        modules += 1;
    }
    println!("{}",serde_json::json!({"modules":modules,"functions":functions,
        "interfacesAndLayoutsMatch":true,"normalizedFunctionBodiesIdentical":identical,
        "semanticEquivalenceProven":false}));
}
