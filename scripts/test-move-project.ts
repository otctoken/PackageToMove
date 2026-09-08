import assert from "node:assert/strict";
import { moveProjectFiles, projectPackages } from "../lib/move-project";
import type { AnalyzeResult, DecompileMetadata, PackageResult } from "../lib/types";
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const pkg = (n: number, deps: number[]): PackageResult => ({ id:id(n), shortId:id(n), version:"1",
  digest:"fixture", status:"ok", depth:n===10?0:1, dependencies:deps.map(id),
  modules:[{name:"same_name", source:"", disassembly:null, functionCount:0, structCount:0, bytecodeSha256:"abc"}] });
const root=pkg(10,[11,12]); const dep=pkg(11,[12]); const shared=pkg(12,[]);
const result={packages:[root,dep,shared,pkg(13,[])]} as AnalyzeResult;
const selected=projectPackages(result, root.id);
assert.deepEqual(selected.map((p)=>p.id), [id(10),id(11),id(12)]);
const sources: Record<string,string>={}; const metadata: Record<string,DecompileMetadata>={};
for (const p of selected) {
  const key=`${p.id}::same_name`;
  sources[key]=`module ${p.id}::same_name;`;
  metadata[key]={engine:"rust-move-decompiler", fallback:false, verification:{
    bytecodeSha256:"abc", knownInstructionCoverage:true, bytecodeVerified:true,
    controlFlowFullyStructured:true, auditWarnings:[],
    canonicalInput:"sui-chain-bytecode", auditPolicy:"fail-closed-v1", bytecodeSize:1,
    sourceViewGenerated:true, functionCount:0, instructionCount:0, constantCount:0,
    abortCount:0, branchCount:0, backwardBranchCount:0, genericCallCount:0, writeRefCount:0,
  }};
}
const files=moveProjectFiles("mainnet", selected, sources, metadata);
assert.equal(files["sources/same_name.move"], sources[`${root.id}::same_name`]);
assert.ok(files[`dependencies/${dep.id}/sources/same_name.move`]);
assert.match(files["Move.toml"], new RegExp(`local = "dependencies/${dep.id}"`));
assert.match(files[`dependencies/${dep.id}/Move.toml`], new RegExp(`local = "../${shared.id}"`));
assert.equal(JSON.parse(files["manifest.json"]).buildVerified, false);
const withSystems = {...root, dependencies: [...root.dependencies, ...Array.from({length:8},(_,i)=>id(i+1))],
  dependencyVersions: {[id(1)]: "25", [id(2)]: "57"}};
const withoutSystemSources = projectPackages({...result, packages:[withSystems,dep,shared]},root.id);
assert.equal(withoutSystemSources.length, 3);
const systemFiles = moveProjectFiles("mainnet",withoutSystemSources,sources,metadata);
assert.doesNotMatch(systemFiles["Move.toml"], /implicit-dependencies = false/);
assert.match(systemFiles["Move.toml"], /sui_system = \{ system = "sui_system" \}/);
assert.ok(!Object.keys(systemFiles).some(path=>path.startsWith(`dependencies/${id(1)}/`)));
assert.equal(JSON.parse(systemFiles["manifest.json"]).packages[0].skippedSystemDependencies.length,8);
assert.throws(()=>projectPackages(result,id(1)), /跳过/);
root.dependencyVersions = {[dep.id]: "2"};
assert.throws(()=>projectPackages(result,root.id), /版本冲突/);
delete root.dependencyVersions;
Object.assign(metadata[`${dep.id}::same_name`], {fallback: true});
assert.throws(()=>moveProjectFiles("mainnet",selected,sources,metadata), /未验证模块/);
metadata[`${dep.id}::same_name`].fallback = false;
delete sources[`${dep.id}::same_name`];
assert.throws(()=>moveProjectFiles("mainnet",selected,sources,metadata), /未验证模块/);
assert.throws(()=>projectPackages({packages:[root]} as AnalyzeResult,root.id), /不完整/);
console.log("Move project export tests passed.");
