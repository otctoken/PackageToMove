/** Delete an UNUSED friend: compilation must still succeed, ACL validation must fail. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BytecodeVerification } from '../lib/types';

const source = resolve(process.argv[2]);
const destination = join(dirname(source), 'tampered-audit');
assert(!existsSync(destination), 'Choose a fresh regression directory');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
assert.equal(manifest.exportMode, 'audit');
const modules: Array<{file:string;compiledModuleId:string;expectedCompiledFriends:string[];
  sourceEdition:string;verification:BytecodeVerification}> = manifest.packages.flatMap((p: {modules:unknown[]})=>p.modules);
let selected: typeof modules[number] | undefined, removed = '';
for (const m of modules) {
  if (m.sourceEdition !== 'legacy' || !m.verification.friendFunctions?.length) continue;
  const unused = m.expectedCompiledFriends.find(id => {
    const caller=modules.find(c=>c.compiledModuleId===id);
    return caller?.verification.calledFunctions &&
      !caller.verification.calledFunctions.some(f=>m.verification.friendFunctions!.includes(f));
  });
  if (unused) { selected=m; removed=unused; break; }
}
assert(selected, 'Fixture must contain a nonempty module with an unused explicit friend');
cpSync(source,destination,{recursive:true,filter:path=>basename(path)!=='build'});
const path=join(destination,selected.file), original=readFileSync(path,'utf8');
const altered=original.replace(`friend ${removed};`,'');
assert.notEqual(altered,original,'Expected exact friend declaration');
writeFileSync(path,altered);
const run=spawnSync(process.execPath,[join(destination,'verify.mjs')],{encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
writeFileSync(join(destination,'negative-test.log'),run.stdout+run.stderr);
assert(!run.error,run.error?.message);
assert.equal(run.status,1,'Removing even an unused permission must fail validation');
const result=JSON.parse(readFileSync(join(destination,'validation.json'),'utf8'));
assert.equal(result.buildPassed,true,'This must exercise the permission gate, not a compile error');
assert.equal(result.validationPassed,false);
assert.equal(result.friendAclPassed,false);
assert.equal(result.friendTablesIdentical,false);
assert(result.friendAclDifferences.some((d:{module:string;missingFriends:string[]})=>
  d.module===selected.compiledModuleId && d.missingFriends.includes(removed)));
assert.match(result.error,/Friend ACL mismatch/);
console.log(`Strict ACL gate rejected removed permission: ${selected.compiledModuleId} -> ${removed}`);
