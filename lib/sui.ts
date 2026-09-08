import { AnalyzeResult, Network, PackageResult } from "@/lib/types";
import { decompileModule } from "@/lib/decompiler";
import { createHash } from "node:crypto";
import { skipSystemDecompilation } from "./system-addresses";

const ENDPOINTS: Record<Network, string> = {
  mainnet:
    process.env.SUI_MAINNET_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql",
  testnet:
    process.env.SUI_TESTNET_GRAPHQL ?? "https://graphql.testnet.sui.io/graphql",
  devnet:
    process.env.SUI_DEVNET_GRAPHQL ?? "https://graphql.devnet.sui.io/graphql",
};

const GRAPHQL_QUERY = `
  query Package($address: SuiAddress!, $after: String, $version: UInt53) {
    object(address: $address, version: $version) {
      package: asMovePackage {
      address
      version
      digest
      linkage {
        originalId
        upgradedId
        version
      }
      modules(first: 5, after: $after) {
        nodes { name bytes disassembly }
        pageInfo { hasNextPage endCursor }
      }
      }
    }
  }
`;

export function normalizePackageId(input: string) {
  const raw = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(raw)) {
    throw new Error("请输入 0x 开头、最多 64 位十六进制的 Sui Package ID");
  }
  return `0x${raw.slice(2).padStart(64, "0")}`;
}

function shortId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 18_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`上游节点返回 HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGraphql(network: Network, id: string, version?: string) {
  type GraphResponse = {
    data?: {
      object?: { package?: {
        address?: string;
        version?: string | number;
        digest?: string;
        linkage?: Array<{
          originalId: string;
          upgradedId: string;
          version: string | number;
        }>;
        modules?: {
          nodes?: Array<{ name: string; bytes?: string; disassembly?: string }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      } };
    };
    errors?: Array<{ message: string }>;
  };
  const modules: Array<{ name: string; bytes?: string; disassembly?: string }> = [];
  let cursor: string | null = null;
  let pinnedVersion = version;
  let pinnedDigest: string | undefined;
  let pkg: NonNullable<NonNullable<NonNullable<GraphResponse["data"]>["object"]>["package"]> | undefined;
  do {
    const result: GraphResponse = await postJson(ENDPOINTS[network], {
      query: GRAPHQL_QUERY,
      variables: { address: id, after: cursor, version: pinnedVersion == null ? null : Number(pinnedVersion) },
    });
    if (result.errors?.length) throw new Error(result.errors[0].message);
    pkg = result.data?.object?.package;
    if (!pkg) {
      throw new Error("该地址不是 Move Package，或在所选网络中不存在");
    }
    if (!pkg.address || normalizePackageId(pkg.address) !== id) {
      throw new Error("Package 地址不匹配：拒绝用升级包替代请求的不可变包");
    }
    if (pkg.version == null) throw new Error("Package 缺少版本，无法固定链上快照");
    if (pinnedVersion != null && String(pkg.version) !== pinnedVersion) throw new Error("Package 版本不匹配");
    pinnedVersion = String(pkg.version);
    if (pinnedDigest && pkg.digest !== pinnedDigest) throw new Error("Package 分页摘要不匹配");
    pinnedDigest = pkg.digest;
    if (!Array.isArray(pkg.linkage)) {
      throw new Error("Sui GraphQL 未返回 Package linkage，无法可靠分析依赖");
    }
    const connection = pkg.modules;
    if (!connection?.nodes || !connection.pageInfo) {
      throw new Error("Package 模块清单不完整");
    }
    for (const module of connection.nodes) {
      if (!module.bytes) throw new Error(`模块 ${module.name} 缺少链上字节码，拒绝生成清单`);
      if (modules.some((existing) => existing.name === module.name)) {
        throw new Error("Package 模块分页重复");
      }
      modules.push(module);
    }
    if (connection.pageInfo.hasNextPage &&
        (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor)) {
      throw new Error("Package 模块分页游标无效");
    }
    cursor = connection?.pageInfo?.hasNextPage
      ? connection.pageInfo.endCursor ?? null
      : null;
  } while (cursor);
  return {
    version: pkg.version == null ? null : String(pkg.version),
    digest: pkg.digest ?? null,
    modules,
    linkage: pkg.linkage,
  };
}

export function dependenciesFromLinkage(
  linkage: Array<{ upgradedId: string }>,
  ownId: string,
) {
  const found = new Set<string>();
  for (const entry of linkage) {
    const raw = entry.upgradedId.trim().toLowerCase();
    if (!/^0x[0-9a-f]{1,64}$/.test(raw)) continue;
    const id = `0x${raw.slice(2).padStart(64, "0")}`;
    if (id !== ownId) found.add(id);
  }
  return [...found];
}

async function fetchPackage(
  network: Network,
  id: string,
  depth: number,
  version?: string,
): Promise<PackageResult> {
  let graphData;
  try {
    graphData = await fetchGraphql(network, id, version);
  } catch (error) {
    return {
      id,
      shortId: shortId(id),
      version: null,
      digest: null,
      modules: [],
      dependencies: [],
      depth,
      status: "unavailable",
      warning: error instanceof Error ? error.message : "无法读取 Package",
    };
  }

  const modules = graphData.modules
    .map((module) => module.name)
    .sort()
    .map((name) => {
      const bytecode =
        graphData.modules.find((module) => module.name === name)?.disassembly ?? null;
      const decompiled = decompileModule(
        name,
        id,
        null,
        bytecode,
      );
      return {
        name,
        bytecodeSha256: createHash("sha256").update(Buffer.from(
          graphData.modules.find((module) => module.name === name)?.bytes ?? "", "base64",
        )).digest("hex"),
        source: decompiled.source,
        disassembly: bytecode,
        functionCount: decompiled.functionCount,
        structCount: decompiled.structCount,
      };
    });

  const dependencies = dependenciesFromLinkage(graphData.linkage, id);

  return {
    id,
    shortId: shortId(id),
    version: graphData.version,
    digest: graphData.digest,
    modules,
    dependencies,
    dependencyVersions: Object.fromEntries(graphData.linkage.map((e) => [normalizePackageId(e.upgradedId), String(e.version)])),
    depth,
    status: "ok",
  };
}

export async function analyzePackage(
  input: string,
  network: Network,
): Promise<AnalyzeResult> {
  const started = Date.now();
  const rootPackage = normalizePackageId(input);
  const seen = new Set<string>([rootPackage]);
  const packages: PackageResult[] = [];
  const warnings: string[] = [];
  let queue: Array<{ id: string; depth: number; version?: string }> = [{ id: rootPackage, depth: 0 }];
  const versions = new Map<string, string>();
  const maxPackages = 120;
  let truncated = false;

  while (queue.length) {
    const batch = queue.splice(0, 8);
    const results = await Promise.all(
      batch.map(({ id, depth, version }): Promise<PackageResult> =>
        skipSystemDecompilation(id) ? Promise.resolve({
          id, shortId: shortId(id), depth, version: version ?? null,
          digest: null, modules: [], dependencies: [], status: "ok",
          decompilationSkipped: true,
        }) : fetchPackage(network, id, depth, version)),
    );
    for (const result of results) {
      packages.push(result);
      if (result.warning) warnings.push(`${result.shortId}: ${result.warning}`);
      for (const dependency of result.dependencies) {
        const version = result.dependencyVersions?.[dependency];
        // Skipped system dependencies are metadata only. No traversal into
        // framework linkage, historical version fetch, or decompiler call.
        if (skipSystemDecompilation(dependency)) {
          if (!seen.has(dependency)) {
            seen.add(dependency);
            queue.push({id: dependency, depth: result.depth + 1, version});
          }
          continue;
        }
        if (version && versions.has(dependency) && versions.get(dependency) !== version) {
          warnings.push(`依赖 ${dependency} 存在版本冲突；保留首次解析版本 ${versions.get(dependency)}，请求版本 ${version}`);
          continue;
        }
        if (version) versions.set(dependency, version);
        if (seen.has(dependency)) continue;
        if (seen.size >= maxPackages) {
          truncated = true;
          continue;
        }
        seen.add(dependency);
        queue.push({ id: dependency, depth: result.depth + 1, version });
      }
    }
  }

  const root = packages.find((pkg) => pkg.id === rootPackage);
  if (!root || root.status === "unavailable") {
    throw new Error(root?.warning ?? "无法读取该 Package");
  }

  return {
    network,
    rootPackage,
    packages: packages.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
    stats: {
      packageCount: packages.length,
      moduleCount: packages.reduce((n, pkg) => n + pkg.modules.length, 0),
      functionCount: packages.reduce(
        (n, pkg) => n + pkg.modules.reduce((m, mod) => m + mod.functionCount, 0),
        0,
      ),
      elapsedMs: Date.now() - started,
      truncated,
    },
    warnings,
  };
}
