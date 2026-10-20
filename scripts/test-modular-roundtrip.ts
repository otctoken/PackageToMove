/** Opt-in isolated-module compiler regression. No publishing or transactions.
 * A test-only caller establishes the original friend table; it is NOT chain code
 * and is never part of the frontend export. All ten real modules are coverage-checked.
 * This is not a full-package build claim: amm_math and sqrt currently have separate
 * definite-assignment compilation failures in their reconstructed condition guards.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { moveProjectFiles } from '../lib/move-project';
import type { DecompileMetadata, PackageResult } from '../lib/types';

mkdirSync('.research', { recursive: true });
const output = process.argv[2] ? resolve(process.argv[2])
  : join(mkdtempSync(resolve('.research/modular-roundtrip-')), 'project');
assert(!existsSync(output), 'Choose a new directory; never overwrite an existing project');
const fixturePath = 'tests/fixtures/modular-bounds-package.json';
const fixture = readFileSync(fixturePath, 'utf8');
const p = JSON.parse(fixture).data.object.package;
const checked = spawnSync(resolve(`target/debug/verify_package${process.platform === 'win32' ? '.exe' : ''}`),
  [], { input: fixture, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
assert.equal(checked.status, 0, checked.stderr);
const sources: Record<string, string> = {}, metadata: Record<string, DecompileMetadata> = {};
const modules = checked.stdout.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).map(line => {
  const m = JSON.parse(line.slice(7)), key = `${p.address}::${m.name}`;
  const bytes = Buffer.from(p.modules.nodes.find((n: {name: string}) => n.name === m.name).bytes, 'base64');
  assert.equal(m.verification.bytecodeSha256, createHash('sha256').update(bytes).digest('hex'));
  sources[key] = m.source;
  metadata[key] = { engine: 'rust-move-decompiler', fallback: false, verification: m.verification };
  return { name: m.name, source: '', disassembly: null, functionCount: m.verification.functionCount,
    structCount: 0, bytecodeSha256: m.verification.bytecodeSha256 };
});
assert.equal(modules.length, 10);
const targetModules = modules.filter(m => m.name === 'modular_bounds');
const pkg: PackageResult = { id: p.address, shortId: p.address, version: String(p.version), digest: p.digest,
  depth: 0, status: 'ok', modules: targetModules, dependencies: p.linkage.map((e: {upgradedId: string}) => e.upgradedId),
  dependencyVersions: Object.fromEntries(p.linkage.map((e: {upgradedId: string; version: number}) => [e.upgradedId, String(e.version)])) };
for (const [name, content] of Object.entries(moveProjectFiles('mainnet', [pkg], sources, metadata))) {
  const path = join(output, name);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
}
// Compilation-only harness, not a substitute for the real amm_math implementation.
// Calling the package-visible function makes the compiler retain the exact friend
// entry. The bytecode comparator independently verifies the target's friend ACL.
writeFileSync(join(output, 'sources', 'compiler_harness.move'), `
// TEST HARNESS ONLY -- NOT DECOMPILED ON-CHAIN SOURCE.
module ${p.address}::amm_math;
public fun compiler_harness() {
    let _ = ${p.address}::modular_bounds::floor_line(0u128, 0u128, 0u128, 1u128);
}
`);
const isolatedFixture = JSON.parse(fixture);
isolatedFixture.data.object.package.modules.nodes = p.modules.nodes.filter((n: {name: string}) => n.name === 'modular_bounds');
const isolatedPath = join(output, 'target-chain-bytecode.json');
writeFileSync(isolatedPath, JSON.stringify(isolatedFixture));
function run(command: string, args: string[], shell = false) {
  const r = spawnSync(command, args, { encoding: 'utf8', shell, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  assert.equal(r.status, 0, r.error?.message || `${command} failed`);
  return r.stdout;
}
run(process.execPath, [join(output, 'verify.mjs')]);
// Tests use unpublishable bytecode headers. Compare a fresh normal build.
run('sui', ['move', 'build', '--path', output, '--silence-warnings'], process.platform === 'win32');
const report = join(output, 'instruction-comparison.json');
const summary = JSON.parse(run(resolve(`target/debug/compare_project${process.platform === 'win32' ? '.exe' : ''}`),
  [isolatedPath, join(output, 'build'), report]).trim());
assert.equal(summary.modules, 1);
assert.equal(summary.functions, 14);
assert.equal(summary.unverifiedBodies, 0);
assert.equal(summary.semanticEquivalenceProven, false);
const functions = JSON.parse(readFileSync(report, 'utf8'));
const target = functions.find((f: {module: string; function: string}) =>
  f.module.endsWith('::modular_bounds') && f.function === 'try_last_floor_euclidean');
assert(target);
assert(['normalized-identical', 'matched-under-model'].includes(target.comparison.status));
writeFileSync(join(output, 'instruction-summary.json'), JSON.stringify(summary, null, 2));
console.log(`10-module coverage; isolated modular_bounds 14-function round-trip and friend ACL passed: ${output}`);
