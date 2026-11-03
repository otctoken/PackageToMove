/** Run MystenLabs' actual verifier for EVERY ordinary package, not only the root.
 * Read-only on chain: never publishes, signs, switches environments or upgrades.
 * A missing toolchain, metadata, network or mismatch is a failure, never a pass.
 */
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const project=resolve(process.argv[2] || '.');
const rest=process.argv.slice(3);
assert(rest.length===0 || (rest.length===2 && rest[0]==='--toolchain'),
  'Usage: tsx scripts/verify-official-source.ts <audit-project> [--toolchain <sui-binary>]');
const toolchain=rest[1]?resolve(rest[1]):undefined;
if(toolchain) assert(existsSync(toolchain),'Toolchain binary does not exist');
const manifestText=readFileSync(join(project,'manifest.json'),'utf8');
const manifest=JSON.parse(manifestText);
assert.equal(manifest.exportMode,'audit','Use the original-address audit export for source verification');
assert(['mainnet','testnet','devnet'].includes(manifest.network),'Invalid network');
assert(manifest.packages.length>0,'Missing packages');
assert(manifest.packages.some((p:{packageId:string})=>p.packageId===manifest.rootPackage),'Root package missing');
assert.equal(new Set(manifest.packages.map((p:{packageId:string})=>p.packageId)).size,manifest.packages.length,'Duplicate packages');
const report={startedAt:new Date().toISOString(),network:manifest.network,rootPackage:manifest.rootPackage,
  manifestSha256:createHash('sha256').update(manifestText).digest('hex'),
  toolchainOverride:toolchain??null,originalToolchainRecovered:false,
  officialSourceVerificationPassed:false,semanticEquivalenceProven:false,
  scope:'Official module bytecode and linkage checks for every exported ordinary package; historical VM/framework behavior is not proved.',
  packages:[] as Array<{packageId:string;exitCode:number|null;passed:boolean;error:string|null;log:string;warnings:string[]}>};
const reportPath=join(project,'official-source-validation.json');
const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2));
save();
// Windows requires the installed sui.cmd shim. Quote each argument, rejecting
// shell expansion syntax rather than interpolating paths into a shell command.
const arg=(s:string)=>{
  if(process.platform!=='win32')return s;
  assert(!/["%!\r\n]/.test(s),'Unsupported shell expansion character in CLI argument');
  return '"'+s+'"';
};
for(const pkg of manifest.packages) {
  assert(/^0x[0-9a-f]{64}$/.test(pkg.packageId),'Invalid package identity');
  const dir=pkg.packageId===manifest.rootPackage?project:join(project,'dependencies',pkg.packageId);
  assert(existsSync(join(dir,'Published.toml')),'Publication metadata missing: '+pkg.packageId);
  const args=['client','--client.env',manifest.network,'verify-source','.',
    ...(toolchain?['--toolchain',toolchain]:[]),'--json'];
  const result=spawnSync('sui',args.map(arg),{cwd:dir,encoding:'utf8',shell:process.platform==='win32',
    timeout:180000,maxBuffer:32*1024*1024});
  const log=`official-source-${pkg.packageId}.log`;
  const output=(result.stdout||'')+(result.stderr||'');
  writeFileSync(join(project,log),output);
  const passed=result.status===0&&!result.error;
  report.packages.push({packageId:pkg.packageId,exitCode:result.status,passed,error:result.error?.message??null,log,
    warnings:output.split(/\r?\n/).filter(line=>/\bWARNING\b/.test(line))});
  save();console.log(`${pkg.packageId}: official source verification ${passed?'PASSED':'FAILED'} (see ${log})`);
}
report.officialSourceVerificationPassed=report.packages.every(p=>p.passed);
save();
console.log(`Official verification passed: ${report.officialSourceVerificationPassed}; report: ${reportPath}`);
if(!report.officialSourceVerificationPassed)process.exitCode=1;
