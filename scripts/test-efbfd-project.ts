import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { moveProjectFiles } from '../lib/move-project';
import type { PackageResult, DecompileMetadata } from '../lib/types';
import { moveAclReader } from '../lib/move-acl-reader';

const output=process.argv[2];
if(!output || existsSync(output)) throw new Error('Choose a new output directory');
const sources:Record<string,string>={}, metadata:Record<string,DecompileMetadata>={};
const packages:PackageResult[]=[];
for(const role of ['root','dependency']) {
  const input=readFileSync(`tests/fixtures/efbfd-${role}.json`,'utf8');
  const p=JSON.parse(input).data.object.package;
  const checked=spawnSync(resolve(`target/debug/verify_package${process.platform==='win32'?'.exe':''}`),[],
    {input,encoding:'utf8',maxBuffer:32*1024*1024});
  assert.equal(checked.status,0,checked.stderr);
  const modules=[];
  for(const line of checked.stdout.split(/\r?\n/).filter(l=>l.startsWith('RESULT '))) {
    const m=JSON.parse(line.slice(7)),key=`${p.address}::${m.name}`;
    const bytes=Buffer.from(p.modules.nodes.find((node:{name:string})=>node.name===m.name).bytes,'base64');
    assert.equal(m.verification.bytecodeSha256,createHash('sha256').update(bytes).digest('hex'));
    sources[key]=m.source;
    metadata[key]={engine:'rust-move-decompiler',fallback:false,verification:m.verification};
    modules.push({name:m.name,source:'',disassembly:null,functionCount:m.verification.functionCount,
      structCount:0,bytecodeSha256:m.verification.bytecodeSha256});
    if(m.name==='fee_collector') assert.match(m.source,/let _ = x2_balance::join/);
    if(m.name==='channel') { assert.match(m.source,/Channel::RealTime =>/); assert.doesNotMatch(m.source,/Channel::RealTime \{\}/); }
  }
  assert.equal(modules.length,p.modules.nodes.length);
  packages.push({id:p.address,shortId:p.address,version:String(p.version),digest:p.digest,
    depth:role==='root'?0:1,status:'ok',modules,dependencies:p.linkage.map((e:{upgradedId:string})=>e.upgradedId),
    dependencyVersions:Object.fromEntries(p.linkage.map((e:{upgradedId:string;version:number})=>[e.upgradedId,String(e.version)]))});
}
const files=moveProjectFiles('mainnet',packages,sources,metadata);
for(const [path,content] of Object.entries(files)) {
  const target=resolve(output,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);
}
console.log(`38 exact-chain modules regenerated into ${resolve(output)}`);
async function verifyOriginalAcl() {
  const {readMoveAcl}=await import('data:text/javascript,'+encodeURIComponent(moveAclReader));
  const manifest=JSON.parse(files['manifest.json']);
  for(const role of ['root','dependency']) {
    const p=JSON.parse(readFileSync(`tests/fixtures/efbfd-${role}.json`,'utf8')).data.object.package;
    const exported=manifest.packages.find((pkg:{packageId:string})=>pkg.packageId===p.address);
    for(const mod of p.modules.nodes) {
      const original=readMoveAcl(Buffer.from(mod.bytes,'base64'));
      const view=exported.modules.find((m:{name:string})=>m.name===mod.name);
      assert.equal(view.compiledModuleId,original.moduleId);
      assert.deepEqual(view.expectedCompiledFriends,original.friends);
    }
  }
  console.log('All exported ACL expectations match original chain binaries.');
}
verifyOriginalAcl().catch(e=>{console.error(e);process.exitCode=1;});
