/** Full-package regression for any fixture whose dependencies are system packages.
 * Never filters module/function names or fabricates callers. Builds both export
 * modes and compares ALL original-address functions, without claiming equivalence.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {moveProjectFiles} from '../lib/move-project';
import type {DecompileMetadata, PackageResult} from '../lib/types';

const fixturePath=process.argv[2];
assert(fixturePath,'Usage: tsx scripts/test-standalone-roundtrip.ts <fixture.json> [new-output-directory]');
const input=readFileSync(fixturePath,'utf8'), p=JSON.parse(input).data.object.package;
assert(p.modules.nodes.length>0,'Empty fixture');
for(const dependency of p.linkage) {
  assert(BigInt(dependency.upgradedId)>BigInt(0) && BigInt(dependency.upgradedId)<=BigInt(8),
    'This runner requires a complete standalone package; use the multi-package runner for ordinary dependencies');
}
mkdirSync('.research',{recursive:true});
const output=process.argv[3]?resolve(process.argv[3]):mkdtempSync(resolve('.research/standalone-roundtrip-'));
if(process.argv[3])assert(!existsSync(output),'Choose a new output directory');
mkdirSync(output,{recursive:true});
const binary=(name:string)=>resolve(process.env.MOVE_CHECKER_BIN_DIR || 'target/debug',name+(process.platform==='win32'?'.exe':''));
function run(command:string,args:string[],input?:string,shell=false) {
  const cliArgs=shell && process.platform==='win32'?args.map(arg=>{
    assert(!/["%!\r\n]/.test(arg),'Unsupported shell expansion character in CLI argument');
    return '"'+arg+'"';
  }):args;
  const result=spawnSync(command,cliArgs,{input,shell,encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
  assert.equal(result.status,0,result.error?.message || result.stderr+result.stdout);
  return result.stdout;
}
const sources:Record<string,string>={}, metadata:Record<string,DecompileMetadata>={};
const modules=run(binary('verify_package'),[],input).split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).map(line=>{
  const m=JSON.parse(line.slice(7)), key=`${p.address}::${m.name}`;
  const original=p.modules.nodes.find((n:{name:string})=>n.name===m.name);
  assert(original,'Unexpected module');
  const hash=createHash('sha256').update(Buffer.from(original.bytes,'base64')).digest('hex');
  assert.equal(hash,m.verification.bytecodeSha256);
  assert.equal(m.bytecodeBase64,original.bytes);
  sources[key]=m.source;
  metadata[key]={engine:'rust-move-decompiler',fallback:false,verification:m.verification,bytecodeBase64:m.bytecodeBase64};
  return {name:m.name,source:'',disassembly:null,functionCount:m.verification.functionCount,structCount:0,bytecodeSha256:hash};
});
assert.equal(modules.length,p.modules.nodes.length);
assert.equal(new Set(modules.map(m=>m.name)).size,modules.length);
const pkg:PackageResult={id:p.address,shortId:p.address,version:String(p.version),digest:p.digest,
  depth:0,status:'ok',modules,dependencies:p.linkage.map((d:{upgradedId:string})=>d.upgradedId),
  dependencyVersions:Object.fromEntries(p.linkage.map((d:{upgradedId:string;version:number})=>[d.upgradedId,String(d.version)]))};
for(const mode of ['audit','new-package'] as const) {
  const project=join(output,mode),files=moveProjectFiles('mainnet',[pkg],sources,metadata,mode);
  assert.equal(Object.keys(files).filter(f=>/^sources\/.*\.move$/.test(f)).length,modules.length);
  assert.equal(Object.keys(files).filter(f=>f.endsWith('.mv.base64')).length,modules.length);
  for(const [name,text] of Object.entries(files)) {
    const path=join(project,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);
  }
  console.log(run(process.execPath,[join(project,'verify.mjs')]));
  const validation=JSON.parse(readFileSync(join(project,'validation.json'),'utf8'));
  assert.equal(validation.validationPassed,true);
  assert.equal(validation.friendAclPassed,true);
  assert.equal(validation.businessTestsVerified,false);
  assert.equal(validation.publishInputGenerated,mode==='new-package');
}
const audit=join(output,'audit');
run('sui',['move','build','--path',audit,'--build-env','mainnet','--silence-warnings'],undefined,process.platform==='win32');
const comparison=spawnSync(binary('compare_project'),[fixturePath,join(audit,'build'),join(output,'instruction-comparison.json')],
  {encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
writeFileSync(join(output,'instruction-summary.json'),comparison.stdout || '{}');
assert.equal(comparison.status,0,comparison.error?.message || comparison.stderr+comparison.stdout);
const summary=JSON.parse(comparison.stdout);
assert.equal(summary.modules,modules.length);
assert.equal(summary.functions,modules.reduce((n,m)=>n+m.functionCount,0));
assert.equal(summary.unverifiedBodies,0);
assert.equal(summary.semanticEquivalenceProven,false);
console.log(`${summary.modules} modules / ${summary.functions} functions: both full exports build; all functions compared under ${summary.instructionModel}. No transactions sent. ${output}`);
