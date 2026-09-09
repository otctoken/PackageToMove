import type { AnalyzeResult, Network, PackageResult } from './types';
import { skipSystemDecompilation } from './system-addresses';
import { postJsonResponse } from './http-json';

type PackagePage = PackageResult & { nextCursor?: string | null };
type Progress = { completed: number; discovered: number; result: AnalyzeResult };
type Options = { signal?: AbortSignal; onProgress?: (progress: Progress) => void };
function normalize(input: string) {
  const raw = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(raw)) throw new Error('请输入有效的 Sui Package ID');
  return `0x${raw.slice(2).padStart(64, '0')}`;
}
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-6)}`;

async function loadPackage(id: string, network: Network, depth: number, version: string | undefined,
  signal?: AbortSignal): Promise<PackageResult> {
  if (skipSystemDecompilation(id)) return { id, shortId: short(id), depth, version: version ?? null,
    digest: null, modules: [], dependencies: [], status: 'ok', decompilationSkipped: true };
  let combined: PackageResult | undefined;
  let after: string | null = null;
  const cursors = new Set<string>(), names = new Set<string>();
  do {
    signal?.throwIfAborted();
    const page: PackagePage = await postJsonResponse('/api/analyze',
      { mode: 'page', packageId: id, network, version, after }, `读取 ${short(id)}`, signal);
    if (page.id !== id) throw new Error('Package 分页地址不匹配');
    if (page.status !== 'ok') throw new Error(page.warning || 'Package 分页读取失败');
    if (!page.version || !Array.isArray(page.modules) || !Array.isArray(page.dependencies) ||
        !('nextCursor' in page) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
      throw new Error('Package 分页响应不完整，请刷新页面后重试');
    }
    if (version != null && page.version !== version) throw new Error('Package 分页版本不匹配');
    if (combined && (page.digest !== combined.digest ||
        JSON.stringify(page.dependencies) !== JSON.stringify(combined.dependencies) ||
        JSON.stringify(page.dependencyVersions) !== JSON.stringify(combined.dependencyVersions))) {
      throw new Error('Package 分页摘要或 linkage 不匹配');
    }
    version = page.version;
    if (!combined) combined = { ...page, modules: [], depth };
    for (const mod of page.modules) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(mod.name) || names.has(mod.name) ||
          !mod.bytecodeSha256 || !/^[0-9a-f]{64}$/.test(mod.bytecodeSha256)) {
        throw new Error('Package 模块分页重复或字节码哈希无效');
      }
      names.add(mod.name); combined.modules.push(mod);
    }
    after = page.nextCursor ?? null;
    if (after && (!page.modules.length || cursors.has(after) || cursors.size >= 1000)) {
      throw new Error('Package 分页游标无效或超过安全页数限制');
    }
    if (after) cursors.add(after);
  } while (after);
  combined!.modules.sort((a, b) => a.name.localeCompare(b.name));
  return combined!;
}

/** Read-only, paginated graph traversal. No one function returns the whole graph. */
export async function analyzeInPages(input: string, network: Network, options: Options = {}): Promise<AnalyzeResult> {
  const rootPackage = normalize(input), started = Date.now();
  const packages: PackageResult[] = [], warnings: string[] = [];
  const seen = new Set([rootPackage]), versions = new Map<string, string>();
  const queue: Array<{ id: string; depth: number; version?: string }> = [{ id: rootPackage, depth: 0 }];
  let truncated = false;
  function snapshot(pending: boolean): AnalyzeResult {
    return { rootPackage, network, packages: [...packages].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
      warnings: [...warnings], stats: { packageCount: packages.length,
        moduleCount: packages.reduce((n, p) => n + p.modules.length, 0),
        functionCount: packages.reduce((n, p) => n + p.modules.reduce((m, x) => m + x.functionCount, 0), 0),
        elapsedMs: Date.now() - started, truncated: truncated || pending } };
  }
  while (queue.length) {
    options.signal?.throwIfAborted();
    const batch = queue.splice(0, 4);
    const results = await Promise.all(batch.map(async ({ id, depth, version }) => {
      try { return await loadPackage(id, network, depth, version, options.signal); }
      catch (error) {
        if (options.signal?.aborted || id === rootPackage) throw error;
        return { id, shortId: short(id), depth, version: version ?? null, digest: null,
          status: 'unavailable' as const, modules: [], dependencies: [],
          warning: error instanceof Error ? error.message : '依赖读取失败' };
      }
    }));
    options.signal?.throwIfAborted();
    for (const pkg of results) {
      packages.push(pkg);
      if (pkg.id === rootPackage && pkg.version) versions.set(pkg.id, pkg.version);
      if (pkg.warning) warnings.push(`${pkg.shortId}: ${pkg.warning}`);
      for (const raw of pkg.dependencies) {
        const id = normalize(raw), version = pkg.dependencyVersions?.[id];
        if (!skipSystemDecompilation(id) && version && versions.has(id) && versions.get(id) !== version) {
          warnings.push(`依赖 ${id} 存在版本冲突；保留 ${versions.get(id)}，请求 ${version}`); continue;
        }
        if (seen.has(id)) continue;
        if (seen.size >= 120) { truncated = true; continue; }
        if (version) versions.set(id, version);
        seen.add(id); queue.push({ id, version, depth: pkg.depth + 1 });
      }
    }
    options.onProgress?.({ completed: packages.length, discovered: seen.size, result: snapshot(queue.length > 0) });
  }
  return snapshot(false);
}
