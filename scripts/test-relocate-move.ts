import assert from 'node:assert/strict';
import { relocateMove, rootModuleIdentities } from '../lib/relocate-move';
const source = `// module 0xabc::fake; 0xabc::m
module 0xabc::m;
use 0x000abc::m;
use 0xabc::external;
const OWNER: address = @0xabc;
const TEXT: vector<u8> = b"0xabc::m";
/* outer /* 0xabc::m */ comment */
public fun f() { 0xabc /* path comment */ ::m::g(); 0xabc1::m::g(); }
`;
const ids = rootModuleIdentities({m:source});
const output = relocateMove(source,ids,'NewPackage');
assert.match(output,/module NewPackage::m;/);
assert.match(output,/use NewPackage::m;/);
assert.match(output,/NewPackage \/\* path comment \*\/ ::m::g/);
assert.ok(output.includes('use 0xabc::external;'));
assert.ok(output.includes('@0xabc'));
assert.ok(output.includes('b"0xabc::m"'));
assert.ok(output.includes('/* outer /* 0xabc::m */ comment */'));
assert.ok(output.includes('0xabc1::m::g()'));
assert.throws(()=>rootModuleIdentities({wrong:source}),/identity mismatch/);
assert.throws(()=>rootModuleIdentities({m:source+'/*'}),/Unterminated/);
assert.throws(()=>rootModuleIdentities({m:source+'module 0xabc::m;'}),/Invalid module/);
assert.throws(()=>relocateMove('use 0xabc::{m, external};',ids,'NewPackage'),/Grouped root imports/);
console.log('Move relocation preserves literals, comments, and dependency identities.');
