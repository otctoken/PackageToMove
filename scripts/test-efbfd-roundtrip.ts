/** Real compiler regression, opt-in: requires Sui CLI and freshly built Rust bins. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

mkdirSync('.research', { recursive: true });
const output = process.argv[2] ? resolve(process.argv[2]) :
  join(mkdtempSync(resolve('.research/efbfd-roundtrip-')), 'project');
assert(!existsSync(output), 'Choose a new output directory; existing data is never overwritten');
function run(command: string, args: string[], shell = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell,
    timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, result.error?.message || `${command} failed`);
  return result.stdout;
}
run(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'),
  'scripts/test-efbfd-project.ts', output]);
run(process.execPath, [join(output, 'verify.mjs')]);
// Sui tests emit unpublishable test headers; compare the normal build only.
run('sui', ['move', 'build', '--path', output, '--silence-warnings'], process.platform === 'win32');
const reports = [];
const checker = resolve(`target/debug/compare_project${process.platform === 'win32' ? '.exe' : ''}`);
for (const [role, functions] of [['root', 103], ['dependency', 192]] as const) {
  writeFileSync(join(output, `chain-input-${role}.json`), readFileSync(`tests/fixtures/efbfd-${role}.json`));
  const reportPath = join(output, `instruction-${role}.json`);
  const summary = JSON.parse(run(checker,
    [`tests/fixtures/efbfd-${role}.json`, join(output, 'build'), reportPath]).trim());
  assert.equal(summary.functions, functions);
  assert.equal(summary.unverifiedBodies, 0);
  assert.equal(summary.instructionModelMatched, true);
  assert.equal(summary.semanticEquivalenceProven, false);
  const details = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(details.length, functions);
  if (role === 'dependency') {
    const fixed = details.find((d: { function: string }) => d.function === 'set_commited_package');
    assert.equal(fixed.comparison.status, 'normalized-identical', 'Call order must exactly round-trip');
  }
  reports.push({ role, ...summary });
}
writeFileSync(join(output, 'instruction-summary.json'), JSON.stringify({
  model: 'paired-instruction-v1-experimental',
  inputSha256: JSON.parse(readFileSync(join(output, 'validation.json'), 'utf8')).inputSha256,
  checkerBinarySha256: createHash('sha256').update(readFileSync(checker)).digest('hex'),
  suiVersion: run('sui', ['--version'], process.platform === 'win32').trim(),
  semanticEquivalenceProven: false,
  scope: 'Exact-bytecode interfaces/layouts/ACLs plus paired instruction diagnostics. Excludes gas, resource limits, framework implementation equivalence and new-package relocation.',
  reports,
}, null, 2));
console.log(`Full 295-function round-trip regression passed: ${output}`);
