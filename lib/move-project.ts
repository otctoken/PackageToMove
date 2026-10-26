import type { AnalyzeResult, DecompileMetadata, PackageResult } from "./types";
import { skipSystemDecompilation, systemDependency } from "./system-addresses";
import { relocateMove, rootModuleIdentities } from "./relocate-move";
import { projectVerifier } from "./project-verifier";
import { adaptFriendSyntax } from "./friend-compatibility";
import { moveAclReader } from "./move-acl-reader";

export type ExportMode = "audit" | "new-package";

const packageName = (id: string) => /^0x0*1$/.test(id) ? "MoveStdlib" :
  /^0x0*2$/.test(id) ? "Sui" : `Package_${id.slice(2)}`;

/** Only the selected package's transitive dependencies belong in this export. */
export function projectPackages(result: AnalyzeResult, rootId: string): PackageResult[] {
  if (skipSystemDecompilation(rootId)) throw new Error("0x1～0x8 系统地址已跳过反编译，不导出源码项目");
  const byId = new Map(result.packages.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const output: PackageResult[] = [];
  function visit(id: string) {
    if (skipSystemDecompilation(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    const pkg = byId.get(id);
    if (!pkg || pkg.status !== "ok" || !pkg.modules.length) {
      throw new Error(`依赖包 ${id} 不完整，无法导出完整 Move 项目`);
    }
    if (pkg.chainId && byId.get(rootId)?.chainId && pkg.chainId !== byId.get(rootId)?.chainId) {
      throw new Error(`依赖 ${id} 链标识不匹配`);
    }
    output.push(pkg);
    for (const dep of pkg.dependencies) {
      if (skipSystemDecompilation(dep)) continue;
      const declared = pkg.dependencyVersions?.[dep];
      const resolved = byId.get(dep)?.version;
      // Never silently substitute conflicting ordinary packages.
      if (declared && declared !== resolved) {
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
  mode: ExportMode = "audit",
) {
  if (!packages.length) throw new Error("没有可导出的包");
  if (!["mainnet", "testnet", "devnet"].includes(network)) throw new Error("Invalid network");
  const root = packages[0];
  const newPackage = mode === "new-package";
  const rootIdentities = newPackage ? rootModuleIdentities(Object.fromEntries(root.modules.map(m =>
    [m.name, sources[`${root.id}::${m.name}`] ?? ""]))) : new Set<string>();
  const files: Record<string, string> = {};
  const manifest: unknown[] = [];
  const ids = new Set(packages.map((p) => p.id));
  for (const pkg of packages) {
    if (skipSystemDecompilation(pkg.id)) throw new Error("系统地址不应加入反编译任务");
    if (!/^0x[0-9a-f]{64}$/.test(pkg.id)) throw new Error("Invalid package path");
    const prefix = pkg.id === root.id ? "" : `dependencies/${pkg.id}/`;
    const deps = pkg.dependencies.flatMap((id) => {
      if (skipSystemDecompilation(id)) {
        const declaration = systemDependency(id);
        return declaration ? [declaration] : [];
      }
      if (!ids.has(id)) throw new Error(`Missing dependency ${id}`);
      const path = pkg.id === root.id ? `dependencies/${id}` :
        id === root.id ? "../.." : `../${id}`;
      // Local dependencies use exactly their declared package name. The Move
      // package manager rejects rename-from when it does not rename anything.
      return [`${packageName(id)} = { local = "${path}" }`];
    });
    files[`${prefix}Move.toml`] = [
      "# Reconstructed project. See manifest.json for provenance and verification limits.",
      "[package]", `name = "${packageName(pkg.id)}"`, 'edition = "2024"',
      ...(newPackage && pkg.id === root.id ? [] : [`published-at = "${pkg.id}"`]),
      "", "[dependencies]", ...deps, "",
    ].join("\n");
    const moduleAddresses = new Set<string>();
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
      const relocated = newPackage && pkg.id === root.id;
      const compatibility = adaptFriendSyntax(source);
      moduleAddresses.add(compatibility.moduleId.split("::")[0]);
      const buildSource = compatibility.source;
      files[file] = relocated ? relocateMove(buildSource, rootIdentities, packageName(root.id)) : buildSource;
      if (compatibility.changed) files[file] = '// BUILD ADAPTER: audit source and exact friend ACL are retained in audit/ and manifest.json.\n' + files[file];
      const auditSourceFile = `${prefix}audit/sources/${mod.name}.move`;
      files[auditSourceFile] = source;
      const buildIdentity = (id: string) => relocated && rootIdentities.has(id) ?
        `0x${'0'.repeat(64)}::${id.split('::')[1]}` : id;
      if (mod.disassembly) files[`${prefix}bytecode/${mod.name}.mv.disasm`] = mod.disassembly;
      return { name: mod.name, file, auditSourceFile, relocated,
        friendSyntaxAdapted:compatibility.changed, compiledModuleId:buildIdentity(compatibility.moduleId),
        expectedCompiledFriends:compatibility.expectedFriends.map(buildIdentity).sort(),
        verificationAppliesTo: "auditSourceFile", verification };
    });
    if (moduleAddresses.size !== 1) throw new Error(`包 ${pkg.id} 的原始模块地址不唯一，无法确定发布依赖身份`);
    const originalId = [...moduleAddresses][0];
    // Live chain identity is preferred (required for resetting devnets). The
    // stable official IDs keep older saved mainnet/testnet analyses usable.
    const chainId = pkg.chainId ?? ({mainnet:'35834a8a',testnet:'4c78adac'} as Record<string,string>)[network];
    if (network === 'devnet' && chainId && /^[0-9a-f]{8}$/.test(chainId)) {
      files[`${prefix}Move.toml`] += `\n[environments]\ndevnet = "${chainId}"\n`;
    }
    if (!(newPackage && pkg.id === root.id) && chainId && /^[0-9a-f]{8}$/.test(chainId) &&
        pkg.version && /^[1-9][0-9]*$/.test(pkg.version)) {
      files[`${prefix}Published.toml`] = [
        '# Reconstructed chain identity only; original toolchain and upgrade capability are unknown.',
        `[published.${network}]`, `chain-id = "${chainId}"`, `published-at = "${pkg.id}"`,
        `original-id = "${originalId}"`, `version = ${pkg.version}`, '',
      ].join('\n');
    }
    manifest.push({ packageId: pkg.id, originalId, chainId:chainId ?? null, version: pkg.version, digest: pkg.digest,
      dependencies: pkg.dependencies, declaredDependencyVersions: pkg.dependencyVersions,
      skippedSystemDependencies: pkg.dependencies.filter(skipSystemDecompilation).map(id => ({
        id, declaredVersion: pkg.dependencyVersions?.[id] ?? null,
        buildResolution: /^0x0*[12]$/.test(id) ? "sui-cli-implicit" :
          systemDependency(id) ? "sui-cli-system" : "excluded-address-not-a-configured-package",
      })),
      resolvedDependencyVersions: Object.fromEntries(pkg.dependencies.map((id) =>
        [id, packages.find((p) => p.id === id)?.version])), modules });
  }
  files["manifest.json"] = JSON.stringify({ network, rootPackage: root.id,
    exportMode: mode,
    originalProjectRecovered: false, historicalBuildEnvironmentRecovered: false,
    relocation: newPackage ? {alias:packageName(root.id), originalModules:[...rootIdentities],
      addressLiteralsPreserved:true, dependencyAddressesPreserved:true} : null,
    publishVerified: false, businessTestsVerified: false,
    packageResolution: "exact-immutable-object-v1", generatedAt: new Date().toISOString(),
    systemDependencyPolicy: "skip-0x1-through-0x8-use-official-toolchain",
    buildVerified: false, semanticEquivalenceVerified: false, packages: manifest }, null, 2);
  files["README.md"] = `# Reconstructed Move project

Root package: ${root.id} (${network}). All package IDs refer to exact chain objects.

Export mode: ${mode}.
${newPackage ? `The ROOT package is prepared as a NEW package using its package-name address.
Its old published-at is removed. audit/sources/ retains the original source view.
Only module/type/call paths owned by the root are relocated, not address literals,
strings, comments, access control, or existing dependency package addresses.
Existing objects and capabilities do not migrate; init will run again on publish.
Hardcoded IDs, type-name comparisons, external package expectations and init
preconditions require manual review. No semantic-equivalence or publish claim is made.
Third-party dependencies remain existing packages, NOT copies to publish anew.
Network-scoped Published.toml files retain both their original bytecode identity
and exact published package object. Validate linkage before root publication.` :
`This is an audit-only project retaining original addresses, not a new publication.`}

Root modules are in sources/. Dependencies are separate local packages in
dependencies/<package-id>/sources/, each with its own Move.toml. Merging them into
the root sources/ would change package ownership and publication semantics.

FRIEND COMPATIBILITY: where bytecode contains friend access, sources/ contains an
explicitly marked 2024 BUILD ADAPTER using public(package). The unmodified audit
view stays in audit/sources/ (and dependencies/<id>/audit/sources/). Consult each
module's auditSourceFile in manifest.json. Do NOT assume these permissions are
equivalent: verify.mjs compares EVERY recompiled module's friend list against the
original list, failing on additions, removals, or missing modules. Only that check
can establish friend-table agreement for this exact build, not full equivalence.
Addresses 0x1 through 0x8 are excluded from decompilation. std/sui are implicit
official toolchain dependencies; 0x3 uses system = "sui_system". 0x5..0x8 are
objects, not packages. No package mapping is invented for 0x4.
The original linkage versions remain in manifest.json. Toolchain-resolved
framework sources are NOT asserted to match those historical versions. Retain
the generated Move.lock and verify dependency compatibility before deployment.

Run locally with a compatible Sui CLI:

    node verify.mjs

This runs sui move build, exact friend-table comparison, and sui move test; it writes build.log/test.log and
validation.json, and exits nonzero on failure. It NEVER publishes or upgrades.
In new-package mode it also generates publish-input.json offline with
--dump-bytecode-as-base64 --no-tree-shaking, checking that only root modules and
the expected existing dependencies are included. This does not execute a publish.
Add business tests under tests/. Zero tests do not establish correct behavior.
Validation results apply only to the hashed local inputs, not future edits.

The download gate checks bytecode verification and source coverage; it is not a
compiler or a proof of semantic equivalence. Build/test results are not asserted
by this archive. On-chain bytecode does not contain the author's test-only code.
Native framework functions may require the matching official framework sources.

This archive is not automatically deployable: a new deployment has a new
package/type identity. Before deploying, review compiler output,
dependency linkage, object compatibility and test results. No transaction is sent.
`;
  files["verify.mjs"] = projectVerifier;
  files["move-acl.mjs"] = moveAclReader;
  files["tests/README.md"] = `# Add application tests here

On-chain bytecode omits the original author's test-only code. No business tests
are invented by this export. Add Move #[test] functions for expected behavior,
abort paths and access control, then run node verify.mjs from the project root.
An empty test suite is reported as zero tests, never as verified business logic.
`;
  return files;
}
