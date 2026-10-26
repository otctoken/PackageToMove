/** Real 37-module regression. Requires Sui CLI and the two local Rust binaries.
 * Builds and tests both export modes; never publishes or sends transactions.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { moveProjectFiles, projectPackages } from '../lib/move-project';
import type { AnalyzeResult, DecompileMetadata, PackageResult } from '../lib/types';

const fixture = JSON.parse(readFileSync('tests/fixtures/optimizer-project.json', 'utf8'));
const packages = projectPackages({ packages: fixture.packages.map((p: {package: PackageResult}) => p.package) } as AnalyzeResult, fixture.rootPackage);
mkdirSync('.research', { recursive: true });
const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(resolve('.research/optimizer-roundtrip-'));
if (process.argv[2]) assert(!existsSync(output), 'Choose a new output directory');
mkdirSync(output, {recursive: true});
const binary = (name: string) => resolve(`target/debug/${name}${process.platform === 'win32' ? '.exe' : ''}`);
const sources: Record<string, string> = {}, metadata: Record<string, DecompileMetadata> = {};
const nodes: Array<{name: string; bytes: string}> = [];
function run(command: string, args: string[], input?: string, shell = false) {
  const r = spawnSync(command, args, {input, shell, encoding:'utf8', timeout:900000, maxBuffer:64*1024*1024});
  assert.equal(r.status, 0, r.error?.message || (r.stderr + r.stdout));
  return r.stdout;
}
for (const pkg of packages) {
  const chain = fixture.packages.find((p: {package: PackageResult}) => p.package.id === pkg.id).chain;
  const original = chain.data.object.package.modules.nodes;
  nodes.push(...original);
  const checked = run(binary('verify_package'), [], JSON.stringify(chain));
  const results = checked.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).map(l => JSON.parse(l.slice(7)));
  assert.equal(results.length, pkg.modules.length);
  for (const m of results) {
    const bytes = Buffer.from(original.find((n: {name: string}) => n.name === m.name).bytes, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, m.verification.bytecodeSha256);
    assert.equal(hash, pkg.modules.find(n => n.name === m.name)?.bytecodeSha256);
    const key = `${pkg.id}::${m.name}`;
    sources[key] = m.source;
    metadata[key] = {engine:'rust-move-decompiler', fallback:false, verification:m.verification};
  }
  console.log(`${pkg.id}: ${results.length} modules covered`);
}
assert.equal(nodes.length, 37);
const chainPath = join(output, 'chain-bytecode.json');
writeFileSync(chainPath, JSON.stringify({data:{object:{package:{modules:{nodes}}}}}));
for (const mode of ['audit', 'new-package'] as const) {
  const project = join(output, mode);
  for (const [name, text] of Object.entries(moveProjectFiles('mainnet', packages, sources, metadata, mode))) {
    const path = join(project, name); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, text);
  }
  console.log(run(process.execPath, [join(project, 'verify.mjs')]));
  const validation = JSON.parse(readFileSync(join(project, 'validation.json'), 'utf8'));
  assert.equal(validation.validationPassed, true);
  assert.equal(validation.friendAclPassed, true);
  assert.equal(validation.businessTestsVerified, false);
  assert.equal(validation.publishInputGenerated,mode==='new-package');
}
// Test compilation uses an unpublishable header. Compare a fresh normal build.
const audit = join(output, 'audit');
run('sui', ['move','build','--path',audit,'--silence-warnings'], undefined, process.platform === 'win32');
const comparison = spawnSync(binary('compare_project'), [chainPath, join(audit,'build'), join(output,'instruction-comparison.json')],
  {encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
// Retain diagnostics on failure as well as success; never turn an incomplete
// comparison into a passing regression.
writeFileSync(join(output,'instruction-summary.json'),comparison.stdout || '{}');
assert.equal(comparison.status,0,comparison.error?.message || comparison.stderr + comparison.stdout);
const summary = JSON.parse(comparison.stdout);
assert.equal(summary.modules,37);
assert.equal(summary.functions,1067);
assert.equal(summary.unverifiedBodies,0);
assert.equal(summary.semanticEquivalenceProven,false);
writeFileSync(join(output,'provenance.json'),JSON.stringify({
  fixtureSha256:createHash('sha256').update(readFileSync('tests/fixtures/optimizer-project.json')).digest('hex'),
  checkerSha256:createHash('sha256').update(readFileSync(binary('compare_project'))).digest('hex'),
  suiVersion:run('sui',['--version'],undefined,process.platform==='win32').trim(),
  scope:'Original-address instruction model; excludes gas, resource limits, historical framework implementations and new-package identity equivalence.',
},null,2));
console.log(`37-module coverage, both builds/tests, friend ACL and instruction comparison passed: ${output}`);
