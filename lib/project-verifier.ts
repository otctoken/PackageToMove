/** Included verbatim in downloads. Runs local checks only, never transactions. */
export const projectVerifier = String.raw`import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMoveAcl } from './move-acl.mjs';

const root = dirname(fileURLToPath(import.meta.url));
function digest() {
  const hash = createHash('sha256');
  function visit(dir, relative = '') {
    for (const entry of readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (['build','.git','bytecode'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported');
      const name = relative + entry.name;
      if (entry.isDirectory()) visit(join(dir,entry.name), name+'/');
      else if (entry.name.endsWith('.move') || entry.name === 'Move.toml' || entry.name === 'manifest.json') {
        hash.update(name); hash.update('\0'); hash.update(readFileSync(join(dir,entry.name))); hash.update('\0');
      }
    }
  }
  visit(root); return hash.digest('hex');
}
const report = {startedAt:new Date().toISOString(), inputSha256:null, buildPassed:false,
  validationPassed:false, friendAclPassed:false,
  testCommandPassed:false, testCount:null, businessTestsVerified:false,
  semanticEquivalenceVerified:false, publishVerified:false, steps:[]};
function save() { writeFileSync(join(root,'validation.json'), JSON.stringify(report,null,2)); }
save(); // Invalidate any previous success before running a new check.
try {
  report.inputSha256 = digest();
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  for (const phase of ['build','test']) {
    const result = spawnSync('sui', ['move',phase,'--path','.','--silence-warnings'],
      {cwd:root,encoding:'utf8',shell:process.platform==='win32',timeout:180000,maxBuffer:32*1024*1024});
    const output = (result.stdout || '') + (result.stderr || '');
    writeFileSync(join(root,phase+'.log'),output);
    process.stdout.write(output);
    report.steps.push({phase,exitCode:result.status,error:result.error?.message ?? null});
    if (result.status !== 0 || result.error) throw new Error(phase+' failed; see '+phase+'.log');
    if (phase === 'build') {
      report.buildPassed = true;
      const compiled=new Map();
      function collect(dir) {
        for(const e of readdirSync(dir,{withFileTypes:true})) {
          if(e.isSymbolicLink()) throw new Error('Symlink in build output');
          const path=join(dir,e.name);
          if(e.isDirectory()) collect(path);
          else if(e.name.endsWith('.mv')) {
            const acl=readMoveAcl(readFileSync(path));
            const previous=compiled.get(acl.moduleId);
            if(previous && JSON.stringify(previous.friends)!==JSON.stringify(acl.friends)) throw new Error('Conflicting compiled module identity');
            compiled.set(acl.moduleId,acl);
          }
        }
      }
      collect(join(root,'build'));
      for(const pkg of manifest.packages) for(const mod of pkg.modules) {
        const actual=compiled.get(mod.compiledModuleId);
        if(!actual || JSON.stringify(actual.friends)!==JSON.stringify(mod.expectedCompiledFriends)) {
          throw new Error('Friend ACL mismatch: '+mod.compiledModuleId+' expected '+JSON.stringify(mod.expectedCompiledFriends)+' actual '+JSON.stringify(actual?.friends));
        }
      }
      report.friendAclPassed=true;
    }
    else {
      report.testCommandPassed = true;
      const summary = /Total tests:\s*(\d+);\s*passed:\s*(\d+);\s*failed:\s*(\d+)/.exec(output);
      report.testCount = summary ? Number(summary[1]) : null;
    }
    save();
  }
  if (digest() !== report.inputSha256) throw new Error('Sources changed during validation');
  report.validationPassed = true;
  console.log('Build and test commands passed. This is NOT semantic-equivalence or publication verification.');
  if (!report.testCount) console.log('No business test cases were verified. Add tests before publication.');
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally { report.finishedAt = new Date().toISOString(); save(); }
`;
