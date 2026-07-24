export type Network = "mainnet" | "testnet" | "devnet";

export type ModuleResult = {
  name: string;
  source: string;
  disassembly: string | null;
  functionCount: number;
  structCount: number;
};

export type PackageResult = {
  id: string;
  shortId: string;
  version: string | null;
  digest: string | null;
  modules: ModuleResult[];
  dependencies: string[];
  depth: number;
  status: "ok" | "partial" | "unavailable";
  warning?: string;
};

export type AnalyzeResult = {
  network: Network;
  rootPackage: string;
  packages: PackageResult[];
  stats: {
    packageCount: number;
    moduleCount: number;
    functionCount: number;
    elapsedMs: number;
    truncated: boolean;
  };
  warnings: string[];
};
