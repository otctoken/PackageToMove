import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adaptFriendSyntax } from '../lib/friend-compatibility';
import { moveAclReader } from '../lib/move-acl-reader';

async function main() {
  const {readMoveAcl}=await import('data:text/javascript,'+encodeURIComponent(moveAclReader));
  const sample='module 0xab::a; friend 0xab::b; public(friend) fun f() {} // public(friend)\nconst S: vector<u8> = b"friend 0xab::b;";';
  const adapted=adaptFriendSyntax(sample);
  assert.equal(adapted.expectedFriends[0],`0x${'ab'.padStart(64,'0')}::b`);
  assert.ok(adapted.source.includes('public(package) fun f()'));
  assert.ok(adapted.source.includes('// public(friend)'));
  assert.ok(adapted.source.includes('b"friend 0xab::b;"'));
  let count=0;
  for(const role of ['root','dependency']) {
    const p=JSON.parse(readFileSync(`tests/fixtures/efbfd-${role}.json`,'utf8')).data.object.package;
    for(const mod of p.modules.nodes) {
      const acl=readMoveAcl(Buffer.from(mod.bytes,'base64'));
      assert.ok(acl.moduleId.endsWith('::'+mod.name));
      assert.equal(new Set(acl.friends).size,acl.friends.length);
      count++;
    }
  }
  assert.equal(count,38);
  assert.throws(()=>readMoveAcl(Buffer.alloc(12)),/magic/);
  console.log('Friend compatibility and 38 original-bytecode ACL parser tests passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
