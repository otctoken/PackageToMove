import { tokens } from './relocate-move';

/** Build-only language adaptation; the canonical audit source is kept separately.
 * Acceptance requires comparing the compiled friend table, not assuming that
 * public(package) has the same permissions as public(friend).
 */
export function adaptFriendSyntax(source: string) {
  const ts = tokens(source);
  const changes: Array<{start:number;end:number;text:string}> = [];
  const friends: string[] = [];
  let moduleId = '';
  const id = (addr:string,name:string) => {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error('Unsupported friend/module identity');
    }
    return `0x${addr.slice(2).toLowerCase().padStart(64,'0')}::${name}`;
  };
  for (let i=0;i<ts.length;i++) {
    if (ts[i].text === 'module' && ts[i+2]?.text === '::') {
      moduleId = id(ts[i+1].text,ts[i+3].text);
    }
    if (ts[i].text === 'friend' && ts[i+2]?.text === '::' && ts[i+4]?.text === ';') {
      friends.push(id(ts[i+1].text,ts[i+3].text));
      changes.push({start:ts[i].start,end:ts[i+4].end,text:'/* Original friend declaration retained in audit source and manifest. */'});
    }
    if (ts[i].text === 'public' && ts[i+1]?.text === '(' && ts[i+2]?.text === 'friend' && ts[i+3]?.text === ')') {
      changes.push({start:ts[i+2].start,end:ts[i+2].end,text:'package'});
    }
  }
  if (!moduleId) throw new Error('Missing module identity');
  const changed = changes.length > 0;
  for (const edit of changes.sort((a,b)=>b.start-a.start)) source = source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return {source,changed,moduleId,expectedFriends:friends.sort()};
}
