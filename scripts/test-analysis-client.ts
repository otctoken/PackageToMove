import assert from 'node:assert/strict';
import { analyzeInPages } from '../lib/analyze-client';
import { postJsonResponse, readJsonResponse } from '../lib/http-json';
import { projectPackages } from '../lib/move-project';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const root = id(32), dep = id(33);
const mod = (name: string) => ({ name, source: '// disassembly', disassembly: 'bytecode',
  bytecodeSha256: 'a'.repeat(64), functionCount: 1, structCount: 0 });
const realFetch = globalThis.fetch;
async function tests() {
  await assert.rejects(readJsonResponse(new Response('An error occurred FUNCTION_INVOCATION_TIMEOUT', { status: 504 }), '分析'), /超时.*504/);
  await assert.rejects(readJsonResponse(new Response('An error occurred FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE', { status: 500 }), '分析'), /大小限制.*500/);
  await assert.rejects(readJsonResponse(new Response('<html>gateway</html>', { status: 502 }), '分析'), /非 JSON.*502/);
  await assert.rejects(readJsonResponse(new Response('null'), '分析'), /结构无效/);
  await assert.rejects(readJsonResponse(Response.json({ error: '保留原始错误' }, { status: 400 }), '分析'), /保留原始错误/);
  assert.deepEqual(await readJsonResponse(Response.json({ ok: true }), '分析'), { ok: true });
  let requests = 0, drift = '', failed = false, sourceBytes = 0, maxPageBytes = 0, large = false;
  globalThis.fetch = async (_url, options) => {
    requests++;
    const b = JSON.parse(String(options?.body));
    assert.equal(b.mode, 'page');
    assert(!/^0x0+[1-8]$/.test(b.packageId), 'System addresses must not be fetched');
    const first = !b.after;
    if (!first) assert.equal(b.version, '2');
    if (failed && b.packageId === dep) return new Response('An error occurred', { status: 504 });
    const p = { id: b.packageId, shortId: b.packageId, depth: 0,
      version: b.packageId === root ? '1' : (!first && drift === 'version' ? '3' : '2'),
      digest: !first && drift === 'digest' ? 'changed' : 'fixed',
      dependencies: b.packageId === root ? [dep, ...Array.from({ length: 8 }, (_, i) => id(i + 1))]
        : (!first && drift === 'linkage' ? [id(34)] : []),
      dependencyVersions: b.packageId === root ? { [dep]: '2' } : {}, status: 'ok',
      modules: [mod(b.packageId === root ? 'root' : (first || drift === 'duplicate' ? 'one' : 'two'))],
      nextCursor: b.packageId === dep && (first || drift === 'cursor') ? 'next' : null };
    if (large) p.modules[0].source = 'x'.repeat(1_700_000);
    const bytes = Buffer.byteLength(JSON.stringify(p));
    sourceBytes += bytes;
    maxPageBytes = Math.max(maxPageBytes, bytes);
    return Response.json(p);
  };
  const progress: number[] = [];
  const result = await analyzeInPages(root, 'mainnet', { onProgress: p => progress.push(p.completed) });
  assert.equal(progress[0], 1, 'Root should be available before dependency traversal');
  assert.equal(requests, 3);
  assert.equal(result.packages.length, 10);
  assert.equal(result.stats.moduleCount, 3);
  assert.equal(result.stats.truncated, false);
  assert.deepEqual(result.packages.find(p => p.id === dep)?.modules.map(m => m.name), ['one', 'two']);
  assert.equal(projectPackages(result, root).length, 2);
  large = true; maxPageBytes = 0;
  const big = await analyzeInPages(root, 'mainnet');
  assert(Buffer.byteLength(JSON.stringify(big)) > 4_500_000, 'Combined graph must exceed platform response cap');
  assert(maxPageBytes < 4_000_000, 'Each page must stay below the server response guard');
  assert.equal(projectPackages(big, root).length, 2);
  assert.equal(big.stats.moduleCount, 3, 'No modules may be dropped to fit the response');
  large = false;
  for (drift of ['version', 'digest', 'duplicate', 'linkage', 'cursor']) {
    const bad = await analyzeInPages(root, 'mainnet');
    assert.equal(bad.packages.find(p => p.id === dep)?.status, 'unavailable');
    assert.throws(() => projectPackages(bad, root), /不完整/);
  }
  drift = ''; failed = true;
  const partial = await analyzeInPages(root, 'mainnet');
  assert.equal(partial.packages.find(p => p.id === root)?.status, 'ok');
  assert.match(partial.warnings.join(' '), /超时/);
  assert.throws(() => projectPackages(partial, root), /不完整/);
  const controller = new AbortController();
  await assert.rejects(analyzeInPages(root, 'mainnet', { signal: controller.signal,
    onProgress: () => controller.abort() }), /abort/i);
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(postJsonResponse('/test', {}, '分析', undefined, 1), /已停止等待/);
  assert(sourceBytes > 0);
  console.log('Paged analysis, progress, identity pinning, failure isolation, cancellation and non-JSON tests passed.');
}
tests().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = realFetch; });
