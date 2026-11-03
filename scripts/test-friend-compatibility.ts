import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adaptFriendSyntax } from '../lib/friend-compatibility';
import { moveAclReader } from '../lib/move-acl-reader';

async function main() {
  const {readMoveAcl,compareFriendAcl}=await import('data:text/javascript,'+encodeURIComponent(moveAclReader));
  const sample='module 0xab::a; friend 0xab::b; public(friend) fun f() {} // public(friend)\nconst S: vector<u8> = b"friend 0xab::b;";';
  const adapted=adaptFriendSyntax(sample);
  const quoted=adaptFriendSyntax('module 0xab::`for`; friend 0xab::`match`; public(friend) fun `fun`() {}');
  assert.equal(quoted.moduleId,`0x${'ab'.padStart(64,'0')}::for`);
  assert.deepEqual(quoted.expectedFriends,[`0x${'ab'.padStart(64,'0')}::match`]);
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
  const fixture=JSON.parse(readFileSync('tests/fixtures/authority-project.json','utf8'));
  const packageId='0x3ec740df8428aa9c93aaef7f8cc1542ac3194fd014826b51bfe245346d64efc7';
  const nodes=fixture.packages.find((p:any)=>p.package.id===packageId).chain.data.object.package.modules.nodes;
  for(const name of ['constants','order_id']) {
    const original=readMoveAcl(Buffer.from(nodes.find((m:any)=>m.name===name).bytes,'base64'));
    assert.equal(original.emptyModule,true);
    assert(original.friends.length>0);
    const empty={...original,friends:[]};
    assert.deepEqual(compareFriendAcl(empty,original.friends,original),{identical:false,emptyModuleMetadataOnly:true});
    assert.throws(()=>compareFriendAcl({...empty,emptyModule:false},original.friends,original),/mismatch/);
    assert.throws(()=>compareFriendAcl(empty,original.friends,{...original,emptyModule:false}),/mismatch/);
    assert.throws(()=>compareFriendAcl(empty,original.friends,undefined),/mismatch/);
    assert.throws(()=>compareFriendAcl({...empty,friends:['0x99::added']},original.friends,original),/mismatch/);
  }
  const executable=readMoveAcl(Buffer.from(nodes.find((m:any)=>m.name==='market').bytes,'base64'));
  assert.equal(executable.emptyModule,false);
  assert.throws(()=>compareFriendAcl({...executable,friends:[]},executable.friends,executable),/mismatch/);
  console.log('Friend compatibility and 38 original-bytecode ACL parser tests passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
