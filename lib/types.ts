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

export type BytecodeVerification = {
  canonicalInput: "sui-chain-bytecode";
  auditPolicy: "fail-closed-v1";
  bytecodeSha256: string;
  bytecodeSize: number;
  bytecodeVerified: boolean;
  sourceViewGenerated: boolean;
  functionCount: number;
  instructionCount: number;
  constantCount: number;
  abortCount: number;
  branchCount: number;
  backwardBranchCount: number;
  genericCallCount: number;
  writeRefCount: number;
  knownInstructionCoverage: boolean;
  controlFlowFullyStructured: boolean;
  auditWarnings: string[];
};

export type DecompileMetadata = {
  engine: "rust-move-decompiler";
  fallback: false;
  verification: BytecodeVerification;
};

export type RustDecompileResponse = {
  packageId: string;
  module: string;
  network: Network;
  source: string;
  engine: "rust-move-decompiler";
  fallback: false;
  verification: BytecodeVerification;
  linkageTable: unknown;
};
