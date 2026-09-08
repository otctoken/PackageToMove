type Token = { text: string; start: number; end: number };

// Retain source spans. Never rewrite comments, strings, or address-valued data.
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unterminated Move comment");
      continue;
    }
    const start = i;
    if (source[i] === '"' || source[i] === '`') {
      const quote = source[i++]; let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i++] === quote) { closed = true; break; }
      }
      if (!closed) throw new Error("Unterminated Move string or identifier");
    } else {
      const match = /^(?:0x[0-9a-fA-F]+|[A-Za-z_][A-Za-z0-9_]*|::)/.exec(source.slice(i));
      i += match ? match[0].length : 1;
    }
    out.push({text:source.slice(start,i),start,end:i});
  }
  return out;
}

const address = (s: string) => /^0x[0-9a-fA-F]{1,64}$/.test(s) ?
  `0x${s.slice(2).toLowerCase().padStart(64,"0")}` : null;

export function rootModuleIdentities(sources: Record<string,string>) {
  const identities = new Set<string>();
  for (const [expectedName, source] of Object.entries(sources)) {
    const ts = tokens(source);
    const declarations = ts.flatMap((t,i) => t.text === "module" ? [i] : []);
    if (declarations.length !== 1) throw new Error(`Invalid module declaration: ${expectedName}`);
    const i = declarations[0];
    const addr = address(ts[i+1]?.text ?? "");
    if (!addr || ts[i+2]?.text !== "::" || ts[i+3]?.text !== expectedName) {
      throw new Error(`Module identity mismatch: ${expectedName}`);
    }
    identities.add(`${addr}::${expectedName}`);
  }
  return identities;
}

export function relocateMove(source: string, identities: Set<string>, alias: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Invalid new package alias");
  const ts = tokens(source);
  const edits: Token[] = [];
  for (let i=0;i<ts.length-2;i++) {
    const addr = address(ts[i].text);
    if (addr && ts[i-1]?.text !== "@" && ts[i+1].text === "::" && ts[i+2].text === "{" &&
        [...identities].some(key => key.startsWith(`${addr}::`))) {
      throw new Error("Grouped root imports require explicit module paths before relocation");
    }
    if (addr && ts[i-1]?.text !== "@" && ts[i+1].text === "::" &&
        identities.has(`${addr}::${ts[i+2].text}`)) edits.push(ts[i]);
  }
  for (const t of edits.reverse()) source = source.slice(0,t.start) + alias + source.slice(t.end);
  return source;
}
