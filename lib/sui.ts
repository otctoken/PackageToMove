import { AnalyzeResult, Network, PackageResult } from "@/lib/types";
import { decompileModule } from "@/lib/decompiler";

const ENDPOINTS: Record<Network, { graphql: string; rpc: string }> = {
  mainnet: {
    graphql:
      process.env.SUI_MAINNET_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql",
    rpc: process.env.SUI_MAINNET_RPC ?? "https://fullnode.mainnet.sui.io:443",
  },
  testnet: {
    graphql:
      process.env.SUI_TESTNET_GRAPHQL ?? "https://graphql.testnet.sui.io/graphql",
    rpc: process.env.SUI_TESTNET_RPC ?? "https://fullnode.testnet.sui.io:443",
  },
  devnet: {
    graphql:
      process.env.SUI_DEVNET_GRAPHQL ?? "https://graphql.devnet.sui.io/graphql",
    rpc: process.env.SUI_DEVNET_RPC ?? "https://fullnode.devnet.sui.io:443",
  },
};

const GRAPHQL_QUERY = `
  query Package($address: SuiAddress!, $after: String) {
    object(address: $address) {
      address
      version
      digest
      asMovePackage {
        modules(first: 5, after: $after) {
          nodes { name disassembly }
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

async function fetchGraphql(network: Network, id: string) {
  type GraphResponse = {
    data?: {
      object?: {
        version?: string | number;
        digest?: string;
        asMovePackage?: {
          modules?: {
            nodes?: Array<{ name: string; disassembly?: string }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          };
        };
      };
    };
    errors?: Array<{ message: string }>;
  };
  const modules: Array<{ name: string; disassembly?: string }> = [];
  let cursor: string | null = null;
  let object: NonNullable<NonNullable<GraphResponse["data"]>["object"]> | undefined;
  do {
    const result: GraphResponse = await postJson(ENDPOINTS[network].graphql, {
      query: GRAPHQL_QUERY,
      variables: { address: id, after: cursor },
    });
    if (result.errors?.length) throw new Error(result.errors[0].message);
    object = result.data?.object;
    if (!object?.asMovePackage) {
      throw new Error("该地址不是 Move Package，或在所选网络中不存在");
    }
    const connection = object.asMovePackage.modules;
    modules.push(...(connection?.nodes ?? []));
    cursor = connection?.pageInfo?.hasNextPage
      ? connection.pageInfo.endCursor ?? null
      : null;
  } while (cursor && modules.length < 150);
  return {
    version: object.version == null ? null : String(object.version),
    digest: object.digest ?? null,
    modules,
  };
}

async function fetchNormalized(network: Network, id: string) {
  const result = await postJson<{
    result?: Record<string, unknown>;
    error?: { message: string };
  }>(ENDPOINTS[network].rpc, {
    jsonrpc: "2.0",
    id: 1,
    method: "sui_getNormalizedMoveModulesByPackage",
    params: [id],
  });
  if (result.error) throw new Error(result.error.message);
  return result.result ?? {};
}

function dependenciesFromText(text: string, ownId: string) {
  const found = new Set<string>();
  const regex = /0x([0-9a-fA-F]{1,64})::/g;
  for (const match of text.matchAll(regex)) {
    const id = `0x${match[1].toLowerCase().padStart(64, "0")}`;
    if (id !== ownId) found.add(id);
  }
  return [...found];
}

function dependenciesFromAbi(value: unknown, ownId: string) {
  const found = new Set<string>();
  const walk = (item: unknown) => {
    if (typeof item === "string" && /^0x[0-9a-f]{1,64}$/i.test(item)) {
      const id = `0x${item.slice(2).toLowerCase().padStart(64, "0")}`;
      if (id !== ownId) found.add(id);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}

async function fetchPackage(
  network: Network,
  id: string,
  depth: number,
): Promise<PackageResult> {
  const [gql, normalized] = await Promise.allSettled([
    fetchGraphql(network, id),
    fetchNormalized(network, id),
  ]);

  if (gql.status === "rejected" && normalized.status === "rejected") {
    return {
      id,
      shortId: shortId(id),
      version: null,
      digest: null,
      modules: [],
      dependencies: [],
      depth,
      status: "unavailable",
      warning: gql.reason instanceof Error ? gql.reason.message : "无法读取 Package",
    };
  }

  const graphData =
    gql.status === "fulfilled"
      ? gql.value
      : { version: null, digest: null, modules: [] };
  const abi = normalized.status === "fulfilled" ? normalized.value : {};
  const moduleNames = new Set([
    ...graphData.modules.map((module) => module.name),
    ...Object.keys(abi),
  ]);

  const modules = [...moduleNames]
    .sort()
    .map((name) => {
      const bytecode =
        graphData.modules.find((module) => module.name === name)?.disassembly ?? null;
      const decompiled = decompileModule(
        name,
        id,
        (abi[name] as Parameters<typeof decompileModule>[2]) ?? null,
        bytecode,
      );
      return {
        name,
        source: decompiled.source,
        disassembly: bytecode,
        functionCount: decompiled.functionCount,
        structCount: decompiled.structCount,
      };
    });

  const corpus = [
    ...graphData.modules.map((module) => module.disassembly ?? ""),
    JSON.stringify(abi),
  ].join("\n");

  const dependencies = new Set([
    ...dependenciesFromText(corpus, id),
    ...dependenciesFromAbi(abi, id),
  ]);

  return {
    id,
    shortId: shortId(id),
    version: graphData.version,
    digest: graphData.digest,
    modules,
    dependencies: [...dependencies],
    depth,
    status:
      gql.status === "fulfilled" && normalized.status === "fulfilled" ? "ok" : "partial",
    warning:
      gql.status === "rejected"
        ? "GraphQL 反汇编暂不可用，已回退到 ABI"
        : normalized.status === "rejected"
          ? "标准化 ABI 暂不可用，已回退到字节码反汇编"
          : undefined,
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
  let queue: Array<{ id: string; depth: number }> = [{ id: rootPackage, depth: 0 }];
  const maxPackages = 120;
  let truncated = false;

  while (queue.length) {
    const batch = queue.splice(0, 8);
    const results = await Promise.all(
      batch.map(({ id, depth }) => fetchPackage(network, id, depth)),
    );
    for (const result of results) {
      packages.push(result);
      if (result.warning) warnings.push(`${result.shortId}: ${result.warning}`);
      for (const dependency of result.dependencies) {
        if (seen.has(dependency)) continue;
        if (seen.size >= maxPackages) {
          truncated = true;
          continue;
        }
        seen.add(dependency);
        queue.push({ id: dependency, depth: result.depth + 1 });
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
