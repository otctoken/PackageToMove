/** Included verbatim in downloads. Runs local checks only, never transactions. */
export const projectVerifier = String.raw`import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
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
      else if (entry.name.endsWith('.move') || ['Move.toml','Published.toml','manifest.json'].includes(entry.name)) {
        hash.update(name); hash.update('\0'); hash.update(readFileSync(join(dir,entry.name))); hash.update('\0');
      }
    }
  }
  visit(root); return hash.digest('hex');
}
const report = {startedAt:new Date().toISOString(), inputSha256:null, buildPassed:false,
  validationPassed:false, friendAclPassed:false,
  testCommandPassed:false, testCount:null, businessTestsVerified:false,
  publishInputGenerated:false,
  semanticEquivalenceVerified:false, publishVerified:false, steps:[]};
function save() { writeFileSync(join(root,'validation.json'), JSON.stringify(report,null,2)); }
save(); // Invalidate any previous success before running a new check.
try {
  report.inputSha256 = digest();
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  if (manifest.exportMode === 'new-package') rmSync(join(root,'publish-input.json'),{force:true});
  if (!['mainnet','testnet','devnet'].includes(manifest.network)) throw new Error('Invalid build network');
  for (const phase of ['build','test']) {
    const result = spawnSync('sui', ['move',phase,'--path','.','--silence-warnings','--build-env',manifest.network],
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
  if (manifest.exportMode === 'new-package') {
    const result = spawnSync('sui',['move','build','--path','.','--silence-warnings','--build-env',manifest.network,
      '--dump-bytecode-as-base64','--no-tree-shaking'],
      {cwd:root,encoding:'utf8',shell:process.platform==='win32',timeout:180000,maxBuffer:32*1024*1024});
    writeFileSync(join(root,'publish-input.log'),(result.stderr || '') + (result.status === 0 ? '' : result.stdout || ''));
    report.steps.push({phase:'publish-input',exitCode:result.status,error:result.error?.message ?? null});
    if(result.status !== 0 || result.error) throw new Error('Offline publish input failed; see publish-input.log');
    const bundle=JSON.parse(result.stdout);
    const own=manifest.packages.find(p=>p.packageId===manifest.rootPackage);
    const actual=bundle.modules.map(bytes=>readMoveAcl(Buffer.from(bytes,'base64')).moduleId).sort();
    const expected=own.modules.map(m=>m.compiledModuleId).sort();
    if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('Publish input must contain only the selected root modules');
    const deps=new Set(bundle.dependencies);
    for(const p of manifest.packages) if(p!==own && !deps.has(p.packageId)) {
      throw new Error('Published dependency identity missing from publish input: '+p.packageId);
    }
    writeFileSync(join(root,'publish-input.json'),JSON.stringify(bundle,null,2));
    report.publishInputGenerated=true;
    console.log('Offline publish input generated for '+actual.length+' root modules; no transaction sent.');
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
