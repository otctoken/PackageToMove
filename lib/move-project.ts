import type { AnalyzeResult, DecompileMetadata, PackageResult } from "./types";

const packageName = (id: string) => /^0x0*1$/.test(id) ? "MoveStdlib" :
  /^0x0*2$/.test(id) ? "Sui" : `Package_${id.slice(2)}`;

/** Only the selected package's transitive dependencies belong in this export. */
export function projectPackages(result: AnalyzeResult, rootId: string): PackageResult[] {
  const byId = new Map(result.packages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const output: PackageResult[] = [];
  function visit(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    const pkg = byId.get(id);
    if (!pkg || pkg.status !== "ok" || !pkg.modules.length) {
      throw new Error(`依赖包 ${id} 不完整，无法导出完整 Move 项目`);
    }
    output.push(pkg);
    for (const dep of pkg.dependencies) {
      const declared = pkg.dependencyVersions?.[dep];
      const resolved = byId.get(dep)?.version;
      // Framework linkage can legitimately retain an older compatible version
      // in a child; never silently substitute conflicting ordinary packages.
      if (declared && declared !== resolved &&
          !(/^0x0*[123]$/.test(dep) && resolved && BigInt(resolved) >= BigInt(declared))) {
        throw new Error(`依赖 ${dep} 版本冲突：需要 ${declared}，解析为 ${resolved ?? "未知"}`);
      }
      visit(dep);
    }
  }
  visit(rootId);
  return output;
}

export function moveProjectFiles(
  network: string,
  packages: PackageResult[],
  sources: Record<string, string>,
  metadata: Record<string, DecompileMetadata>,
) {
  if (!packages.length) throw new Error("没有可导出的包");
  const root = packages[0];
  const files: Record<string, string> = {};
  const manifest: unknown[] = [];
  const ids = new Set(packages.map((p) => p.id));
  for (const pkg of packages) {
    if (!/^0x[0-9a-f]{64}$/.test(pkg.id)) throw new Error("Invalid package path");
    const prefix = pkg.id === root.id ? "" : `dependencies/${pkg.id}/`;
    const deps = pkg.dependencies.map((id) => {
      if (!ids.has(id)) throw new Error(`Missing dependency ${id}`);
      const path = pkg.id === root.id ? `dependencies/${id}` :
        id === root.id ? "../.." : `../${id}`;
      const alias = /^0x0*1$/.test(id) ? "std" : /^0x0*2$/.test(id) ? "sui" : packageName(id);
      return `${alias} = { local = "${path}", rename-from = "${packageName(id)}" }`;
    });
    files[`${prefix}Move.toml`] = [
      "# Reconstructed project; chain address is retained for audit builds.",
      "[package]", `name = "${packageName(pkg.id)}"`, 'edition = "2024"',
      'implicit-dependencies = false', `published-at = "${pkg.id}"`,
      "", "[dependencies]", ...deps, "",
    ].join("\n");
    const modules = pkg.modules.map((mod) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(mod.name)) throw new Error("Invalid module path");
      const key = `${pkg.id}::${mod.name}`;
      const source = sources[key];
      const verification = metadata[key]?.verification;
      if (!source || metadata[key]?.fallback || metadata[key]?.engine !== "rust-move-decompiler" ||
          verification?.canonicalInput !== "sui-chain-bytecode" ||
          verification?.auditPolicy !== "fail-closed-v1" || !verification.sourceViewGenerated ||
          !verification?.knownInstructionCoverage ||
          !verification.bytecodeVerified || !verification.controlFlowFullyStructured ||
          verification.auditWarnings.length || !mod.bytecodeSha256 ||
          verification.bytecodeSha256 !== mod.bytecodeSha256) {
        throw new Error(`未验证模块 ${key}，取消导出`);
      }
      const file = `${prefix}sources/${mod.name}.move`;
      files[file] = source;
      if (mod.disassembly) files[`${prefix}bytecode/${mod.name}.mv.disasm`] = mod.disassembly;
      return { name: mod.name, file, verification };
    });
    manifest.push({ packageId: pkg.id, version: pkg.version, digest: pkg.digest,
      dependencies: pkg.dependencies, declaredDependencyVersions: pkg.dependencyVersions,
      resolvedDependencyVersions: Object.fromEntries(pkg.dependencies.map((id) =>
        [id, packages.find((p) => p.id === id)?.version])), modules });
  }
  files["manifest.json"] = JSON.stringify({ network, rootPackage: root.id,
    packageResolution: "exact-immutable-object-v1", generatedAt: new Date().toISOString(),
    buildVerified: false, semanticEquivalenceVerified: false, packages: manifest }, null, 2);
  files["README.md"] = `# Reconstructed Move project

Root package: ${root.id} (${network}). All package IDs refer to exact chain objects.

Root modules are in sources/. Dependencies are separate local packages in
dependencies/<package-id>/sources/, each with its own Move.toml. Merging them into
the root sources/ would change package ownership and publication semantics.

Run locally with a compatible Sui CLI:

    sui move build
    sui move test

The download gate checks bytecode verification and source coverage; it is not a
compiler or a proof of semantic equivalence. Build/test results are not asserted
by this archive. On-chain bytecode does not contain the author's test-only code.
Native framework functions may require the matching official framework sources.

Published addresses are retained for auditing. This archive is not automatically
republishable: a new deployment has a new package/type identity, and an upgrade
requires the appropriate UpgradeCap. Before deploying, review compiler output,
dependency linkage, object compatibility and test results. No transaction is sent.
`;
  return files;
}
