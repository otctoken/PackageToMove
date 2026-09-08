/** User-requested exclusion range, not a claim that every ID is a package.
 * 0x5..0x8 are singleton objects; 0x4 has no assumed package mapping.
 */
export function skipSystemDecompilation(id: string): boolean {
  return /^0x0*[1-8]$/i.test(id);
}

export function systemDependency(id: string): string | null {
  if (/^0x0*3$/i.test(id)) return 'sui_system = { system = "sui_system" }';
  // std/sui are implicit in the current official package manager.
  return null;
}
