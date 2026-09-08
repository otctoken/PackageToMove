import assert from "node:assert/strict";
import { moveProjectFiles, projectPackages } from "../lib/move-project";
import type { AnalyzeResult, DecompileMetadata, PackageResult } from "../lib/types";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
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
  sources[key]=`module ${p.id}::same_name; public fun value(): u64 { 1 }`;
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
const fresh = moveProjectFiles("mainnet",selected,sources,metadata,"new-package");
assert.doesNotMatch(fresh["Move.toml"], /published-at/);
assert.match(fresh["sources/same_name.move"], /module Package_/);
assert.equal(fresh["audit/sources/same_name.move"], sources[`${root.id}::same_name`]);
assert.equal(fresh[`dependencies/${dep.id}/sources/same_name.move`], sources[`${dep.id}::same_name`]);
assert.match(fresh[`dependencies/${dep.id}/Move.toml`], /published-at/);
assert.equal(JSON.parse(fresh["manifest.json"]).publishVerified,false);
assert.ok(fresh["verify.mjs"].includes("['build','test']"));
for (const project of [files,fresh]) {
  for (const [path,content] of Object.entries(project)) {
    if (path.endsWith("Move.toml")) assert.doesNotMatch(content,/rename-from/);
  }
}
// Optional real CLI regression: reproduce the old error, then build both modes.
if (process.argv.includes("--build")) {
  const workspace = mkdtempSync(join(tmpdir(),"move-manifest-regression-"));
  function writeProject(folder:string, project:Record<string,string>) {
    const directory = join(workspace,folder);
    for (const [path,content] of Object.entries(project)) {
      const target = join(directory,path);
      mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,content);
    }
    return directory;
  }
  function build(directory:string) {
    return spawnSync("sui",["move","build","--path",".","--silence-warnings"],
      {cwd:directory,encoding:"utf8",shell:process.platform==="win32",timeout:180000,maxBuffer:8*1024*1024});
  }
  const old = {...files, "Move.toml":files["Move.toml"].replace(
    `local = "dependencies/${dep.id}"`,
    `local = "dependencies/${dep.id}", rename-from = "Package_${dep.id.slice(2)}"`)};
  const failed = build(writeProject("redundant",old));
  assert.notEqual(failed.status,0);
  assert.match((failed.stdout??"")+(failed.stderr??""),/unnecessary[\s\S]*rename-from|already named/);
  for (const [mode,project] of [["audit",files],["new-package",fresh]] as const) {
    const checked = build(writeProject(mode,project));
    assert.equal(checked.status,0,(checked.stdout??"")+(checked.stderr??"")+String(checked.error??""));
    console.log(`${mode}: actual Sui build passed`);
  }
  console.log(`Manifest regression artifacts: ${workspace}`);
}
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
