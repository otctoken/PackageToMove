/** Compile real Move binaries: no normalization of Call into Vec* is allowed. */
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const out=resolve(process.argv[2] || '.research/vector-intrinsics');
assert(!existsSync(out),'Choose a new output directory');
const address='0x'+'a1'.repeat(32);
const name='VectorIntrinsics';
const bin=(n:string)=>resolve(process.env.MOVE_CHECKER_BIN_DIR||'target/debug',n+(process.platform==='win32'?'.exe':''));
function run(command:string,args:string[],input?:string) {
 const r=spawnSync(command,args,{encoding:'utf8',input,timeout:900000,maxBuffer:64*1024*1024,
  shell:process.platform==='win32'&&command==='sui'});
 assert.equal(r.status,0,r.error?.message||r.stderr+r.stdout);return r.stdout;
}
const original={
 ops:`module ${address}::ops {
 friend ${address}::unused;
 public fun empty<T>(): vector<T> { vector[] }
 public fun length<T>(v: &vector<T>): u64 { std::vector::length(v) }
 public fun original_native_call<T>(v: &vector<T>): u64 { 0x1::vector::length(v) }
 public fun user_vector_call(v: &vector<u64>): u64 { ${address}::vector::length(v) }
 public fun borrow<T>(v: &vector<T>, i: u64): &T { std::vector::borrow(v, i) }
 public fun borrow_mut<T>(v: &mut vector<T>, i: u64): &mut T { std::vector::borrow_mut(v, i) }
 public(friend) fun push<T>(v: &mut vector<T>, x: T) { std::vector::push_back(v, x) }
 public fun pop<T>(v: &mut vector<T>): T { std::vector::pop_back(v) }
 public fun destroy<T>(v: vector<T>) { std::vector::destroy_empty(v) }
 public fun swap<T>(v: &mut vector<T>, i: u64, j: u64) { std::vector::swap(v, i, j) }
 public fun set_flag(flag: &mut bool, amount: u64) {
   let selected=if (amount > 0) { true } else { false };
   *flag=selected;
 }
}`,
 unused:`module ${address}::unused {}`,
 vector:`module ${address}::vector { public fun length(v: &vector<u64>): u64 { std::vector::length(v) + 1 } }`,
};
function build(label:string,sources:Record<string,string>) {
 const dir=join(out,label);mkdirSync(join(dir,'sources'),{recursive:true});
 writeFileSync(join(dir,'Move.toml'),`[package]\nname = "${name}"\nedition = "legacy"\n`);
 for(const [n,s]of Object.entries(sources))writeFileSync(join(dir,'sources',n+'.move'),s);
 const log=run('sui',['move','build','--path',dir,'--silence-warnings']);
 writeFileSync(join(dir,'build.log'),log);return dir;
}
const base=build('original',original);
const modules=join(base,'build',name,'bytecode_modules');
const nodes=readdirSync(modules).filter(n=>n.endsWith('.mv')).map(n=>({name:n.slice(0,-3),bytes:readFileSync(join(modules,n)).toString('base64')}));
assert.equal(nodes.length,3);
const chain=JSON.stringify({data:{object:{package:{modules:{nodes}}}}});
const chainFile=join(out,'chain-bytecode.json');writeFileSync(chainFile,chain);
const checked=run(bin('verify_package'),[],chain).split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).map(l=>JSON.parse(l.slice(7)));
const sources:Record<string,string>={};
for(const m of checked){assert(m.legacySource);sources[m.name]=m.legacySource;}
const fixed=build('reconstructed',sources);
function compare(dir:string,pass:boolean) {
 const r=spawnSync(bin('compare_project'),[chainFile,join(dir,'build'),join(dir,'instruction-comparison.json')],
  {encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
 assert(!r.error,r.error?.message);assert.equal(r.status,pass?0:1,r.stderr+r.stdout);
 const result=JSON.parse(r.stdout);writeFileSync(join(dir,'instruction-summary.json'),JSON.stringify(result,null,2));
 assert.equal(result.friendTablesIdentical,true);assert.equal(result.interfacesAndLayoutsMatch,true);
 assert.equal(result.unverifiedBodies===0,pass);return result;
}
compare(fixed,true);
// Returning an element at a different index must not be accepted.
const wrongIndex=sources.ops.replace('std::vector::borrow(l0, l1)','std::vector::borrow(l0, 0u64)');
assert.notEqual(wrongIndex,sources.ops);
compare(build('wrong-index',{...sources,ops:wrongIndex}),false);
// The old bug still compiles, but must fail the unchanged strict comparator.
const nativeCalls=sources.ops.replaceAll('std::vector::','0x1::vector::');
assert.notEqual(nativeCalls,sources.ops);
compare(build('numeric-native-calls',{...sources,ops:nativeCalls}),false);
// Swapping the selected boolean changes the stored value, not just presentation.
const wrongFlag=sources.ops.replace(/if \(([^\n]+)\) \{\s*true\s*\} else \{\s*false\s*\}/,
  'if ($1) { false } else { true }');
assert.notEqual(wrongFlag,sources.ops);
compare(build('wrong-boolean',{...sources,ops:wrongFlag}),false);
console.log('All eight vector opcodes, original native/user calls and boolean branch round-trip passed; three semantic/instruction mutations rejected.');
