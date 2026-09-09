// Generated standalone verifier reads only standard binary tables; it never
// interprets or executes Move instructions. Unsupported formats fail closed.
export const moveAclReader = String.raw`export function readMoveAcl(bytes) {
  let p = 0;
  function byte() { if (p >= bytes.length) throw new Error('Truncated Move binary'); return bytes[p++]; }
  function uleb() {
    let value=0,scale=1;
    for(let i=0;i<5;i++) { const b=byte(); value+=(b&127)*scale; if(!(b&128)) return value; scale*=128; }
    throw new Error('Invalid ULEB');
  }
  if ([byte(),byte(),byte(),byte()].join(',') !== '161,28,235,11') throw new Error('Invalid Move magic');
  const rawVersion = (byte() | byte()<<8 | byte()<<16 | byte()<<24) >>> 0;
  const version = rawVersion & 0xffffff;
  if(version < 5 || version > 7) throw new Error('Unsupported Move version: '+version);
  const count=uleb(); const tables=new Map(); let length=0;
  for(let i=0;i<count;i++) {
    const kind=byte(), offset=uleb(), size=uleb();
    if(tables.has(kind)) throw new Error('Duplicate Move table');
    tables.set(kind,{offset,size}); length=Math.max(length,offset+size);
  }
  const base=p;
  if(base+length>=bytes.length) throw new Error('Invalid Move table bounds');
  function table(kind,decode) {
    const t=tables.get(kind); if(!t) return [];
    p=base+t.offset; const end=p+t.size; const result=[];
    while(p<end) result.push(decode());
    if(p!==end) throw new Error('Invalid table boundary');
    return result;
  }
  const identifiers=table(7,()=>{const n=uleb(), start=p; p+=n; if(p>bytes.length) throw new Error('Invalid identifier'); return bytes.subarray(start,p).toString('utf8');});
  const addresses=table(8,()=>{const start=p;p+=32;return '0x'+bytes.subarray(start,p).toString('hex');});
  const handle=()=>{const a=uleb(),n=uleb(); if(!addresses[a]||!identifiers[n]) throw new Error('Invalid module handle');return addresses[a]+'::'+identifiers[n];};
  const modules=table(1,handle),friends=table(15,handle).sort();
  p=base+length; const self=uleb();
  if(!modules[self]) throw new Error('Invalid self module');
  return {moduleId:modules[self],friends};
}
`;
