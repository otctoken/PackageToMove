// Reproduce a frontend Download All export with the local Rust engine.
// Run after `cargo build --bin verify_package`:
// npx tsx scripts/export-chain-project.ts <package-id> <new-output-directory>
import { analyzePackage } from "../lib/sui";
import { getMoveModuleBytecode } from "../lib/bytecode";
import { moveProjectFiles, projectPackages } from "../lib/move-project";
import type { DecompileMetadata } from "../lib/types";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

async function main() {
  const [id, directory] = process.argv.slice(2);
  if (!id || !directory) throw new Error("Expected package ID and new output directory");
  const output = resolve(directory);
  if (existsSync(output)) throw new Error("Output directory already exists; choose a new directory");
  const analysis = await analyzePackage(id, "mainnet");
  const packages = projectPackages(analysis, analysis.rootPackage);
  const sources: Record<string, string> = {};
  const metadata: Record<string, DecompileMetadata> = {};
  for (const pkg of packages) {
    console.log(`Checking ${pkg.id} v${pkg.version}, ${pkg.modules.length} modules`);
    const nodes = [];
    for (const m of pkg.modules) {
      const b = await getMoveModuleBytecode(pkg.id, m.name, "mainnet", pkg.version);
      nodes.push({name:m.name, bytes:b.bytecode});
    }
    const binary = resolve(`target/debug/verify_package${process.platform === "win32" ? ".exe" : ""}`);
    const result = spawnSync(binary, [], { input: JSON.stringify({data:{object:{package:{modules:{nodes}}}}}),
      encoding:"utf8", maxBuffer:64*1024*1024 });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    for (const line of result.stdout.split(/\r?\n/).filter((s) => s.startsWith("RESULT "))) {
      const m = JSON.parse(line.slice(7));
      const key = `${pkg.id}::${m.name}`;
      sources[key] = m.source;
      metadata[key] = {engine:"rust-move-decompiler", fallback:false, verification:m.verification};
    }
  }
  const files = moveProjectFiles("mainnet", packages, sources, metadata);
  for (const [path, text] of Object.entries(files)) {
    const target = resolve(output, path);
    if (!target.startsWith(output + "/") && !target.startsWith(output + "\\")) throw new Error("Invalid path");
    mkdirSync(dirname(target), {recursive:true});
    writeFileSync(target, text);
  }
  console.log(`Exported ${Object.keys(files).length} files to ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode=1; });
