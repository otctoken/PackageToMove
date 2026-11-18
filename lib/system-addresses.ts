/** User-requested exclusion range, not a claim that every ID is a package.
 * 0x5..0x8 are singleton objects; 0x4 has no assumed package mapping.
 */
export function skipSystemDecompilation(id: string): boolean {
  return /^0x0*[1-8]$/i.test(id);
}

// Build profile for both export modes. The target network still supplies
// publication identities; its linkage version is not a Git revision.
export const buildFramework = {
  release: "testnet-v1.84.0",
  revision: "9dc25070cf2ed18bcda1ebb095f39708638195a8",
  repository: "https://github.com/MystenLabs/sui.git",
} as const;

export function frameworkDependency(name: "std" | "sui" | "sui_system"): string {
  const directory = {std: "move-stdlib", sui: "sui-framework", sui_system: "sui-system"}[name];
  return `${name} = { git = "${buildFramework.repository}", subdir = "crates/sui-framework/packages/${directory}", rev = "${buildFramework.revision}" }`;
}
