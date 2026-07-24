import { Network } from "@/lib/types";
import { normalizePackageId } from "@/lib/sui";

const RPC_ENDPOINTS: Record<Network, string> = {
  mainnet: process.env.SUI_MAINNET_RPC ?? "https://fullnode.mainnet.sui.io:443",
  testnet: process.env.SUI_TESTNET_RPC ?? "https://fullnode.testnet.sui.io:443",
  devnet: process.env.SUI_DEVNET_RPC ?? "https://fullnode.devnet.sui.io:443",
};

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
    result?: {
      data?: {
        bcs?: {
          dataType?: string;
          moduleMap?: Record<string, string>;
        };
      };
    };
    error?: { message?: string };
  }>(
    RPC_ENDPOINTS[network],
    {
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getObject",
      params: [packageId, { showBcs: true }],
    },
    20_000,
  );
  if (response.error) throw new Error(response.error.message ?? "读取 Package 失败");
  const bcs = response.result?.data?.bcs;
  if (bcs?.dataType !== "package") throw new Error("该地址不是 Move Package");
  const encoded = bcs.moduleMap?.[moduleName];
  if (!encoded) throw new Error(`Package 中不存在模块 ${moduleName}`);
  return Buffer.from(encoded, "base64").toString("hex");
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
    bytecode: Buffer.from(bytecode, "hex").toString("base64"),
  };
}
