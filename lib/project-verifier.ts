/** Included verbatim in downloads. Runs local checks only, never transactions. */
export const projectVerifier = String.raw`import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
function digest() {
  const hash = createHash('sha256');
  function visit(dir, relative = '') {
    for (const entry of readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (['build','.git','audit','bytecode'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported');
      const name = relative + entry.name;
      if (entry.isDirectory()) visit(join(dir,entry.name), name+'/');
      else if (entry.name.endsWith('.move') || entry.name === 'Move.toml') {
        hash.update(name); hash.update('\0'); hash.update(readFileSync(join(dir,entry.name))); hash.update('\0');
      }
    }
  }
  visit(root); return hash.digest('hex');
}
const report = {startedAt:new Date().toISOString(), inputSha256:null, buildPassed:false,
  validationPassed:false,
  testCommandPassed:false, testCount:null, businessTestsVerified:false,
  semanticEquivalenceVerified:false, publishVerified:false, steps:[]};
function save() { writeFileSync(join(root,'validation.json'), JSON.stringify(report,null,2)); }
save(); // Invalidate any previous success before running a new check.
try {
  report.inputSha256 = digest();
  for (const phase of ['build','test']) {
    const result = spawnSync('sui', ['move',phase,'--path','.','--silence-warnings'],
      {cwd:root,encoding:'utf8',shell:process.platform==='win32',timeout:180000,maxBuffer:32*1024*1024});
    const output = (result.stdout || '') + (result.stderr || '');
    writeFileSync(join(root,phase+'.log'),output);
    process.stdout.write(output);
    report.steps.push({phase,exitCode:result.status,error:result.error?.message ?? null});
    if (result.status !== 0 || result.error) throw new Error(phase+' failed; see '+phase+'.log');
    if (phase === 'build') report.buildPassed = true;
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
