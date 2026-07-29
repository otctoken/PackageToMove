import { Network } from "@/lib/types";
import { normalizePackageId } from "@/lib/sui";

const GRAPHQL_ENDPOINTS: Record<Network, string> = {
  mainnet:
    process.env.SUI_MAINNET_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql",
  testnet:
    process.env.SUI_TESTNET_GRAPHQL ?? "https://graphql.testnet.sui.io/graphql",
  devnet:
    process.env.SUI_DEVNET_GRAPHQL ?? "https://graphql.devnet.sui.io/graphql",
};

const MODULE_QUERY = `
  query ModuleBytecode($address: SuiAddress!, $module: String!) {
    package(address: $address) {
      module(name: $module) {
        name
        bytes
      }
    }
  }
`;

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
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
    const text = await response.text();
    if (!response.ok) throw new Error(`Sui 节点返回 HTTP ${response.status}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchModuleBytecode(
  packageId: string,
  moduleName: string,
  network: Network,
) {
  const response = await postJson<{
    data?: {
      package?: {
        module?: {
          name: string;
          bytes?: string;
        };
      };
    };
    errors?: Array<{ message: string }>;
  }>(
    GRAPHQL_ENDPOINTS[network],
    {
      query: MODULE_QUERY,
      variables: { address: packageId, module: moduleName },
    },
    20_000,
  );
  if (response.errors?.length) throw new Error(response.errors[0].message);
  const pkg = response.data?.package;
  if (!pkg) throw new Error("该地址不是 Move Package，或在所选网络中不存在");
  const module = pkg.module;
  if (!module || module.name !== moduleName) {
    throw new Error(`Package 中不存在模块 ${moduleName}`);
  }
  const encoded = module.bytes;
  if (!encoded) throw new Error(`Package 中不存在模块 ${moduleName}`);
  return encoded;
}

export async function getMoveModuleBytecode(
  inputPackageId: string,
  moduleName: string,
  network: Network,
) {
  const packageId = normalizePackageId(inputPackageId);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) {
    throw new Error("无效的 Move 模块名");
  }
  const bytecode = await fetchModuleBytecode(packageId, moduleName, network);
  return {
    packageId,
    module: moduleName,
    bytecode,
  };
}
