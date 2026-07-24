type NormalizedType =
  | string
  | { Vector: NormalizedType }
  | { Reference: NormalizedType }
  | { MutableReference: NormalizedType }
  | {
      Struct: {
        address: string;
        module: string;
        name: string;
        typeArguments?: NormalizedType[];
      };
    }
  | { TypeParameter: number };

type NormalizedModule = {
  address?: string;
  name?: string;
  fileFormatVersion?: number;
  friends?: Array<
    | string
    | {
        address?: string;
        module?: string;
        name?: string;
      }
  >;
  structs?: Record<
    string,
    {
      abilities?: string[];
      typeParameters?: Array<{ constraints?: string[]; isPhantom?: boolean }>;
      fields?: Array<{ name: string; type: NormalizedType }>;
    }
  >;
  exposedFunctions?: Record<
    string,
    {
      visibility?: string;
      isEntry?: boolean;
      typeParameters?: string[][];
      parameters?: NormalizedType[];
      return?: NormalizedType[];
    }
  >;
};

function shortAddress(value: string) {
  const normalized = value.toLowerCase().replace(/^0x0+/, "0x");
  return normalized === "0x" ? "0x0" : normalized;
}

function typeToMove(type: NormalizedType, names: string[] = []): string {
  if (typeof type === "string") return type.toLowerCase();
  if ("Vector" in type) return `vector<${typeToMove(type.Vector, names)}>`;
  if ("Reference" in type) return `&${typeToMove(type.Reference, names)}`;
  if ("MutableReference" in type)
    return `&mut ${typeToMove(type.MutableReference, names)}`;
  if ("TypeParameter" in type) return names[type.TypeParameter] ?? `T${type.TypeParameter}`;
  if ("Struct" in type) {
    const s = type.Struct;
    const args = s.typeArguments?.length
      ? `<${s.typeArguments.map((t) => typeToMove(t, names)).join(", ")}>`
      : "";
    return `${shortAddress(s.address)}::${s.module}::${s.name}${args}`;
  }
  return "/* unknown */";
}

function genericNames(count = 0) {
  return Array.from({ length: count }, (_, i) =>
    i < 26 ? String.fromCharCode(84 + i) : `T${i}`,
  );
}

function formatGenerics(
  params: Array<{ constraints?: string[]; isPhantom?: boolean }> | string[][] = [],
) {
  const names = genericNames(params.length);
  if (!params.length) return { names, text: "" };
  const values = params.map((param, index) => {
    const constraints = Array.isArray(param) ? param : param.constraints ?? [];
    const phantom = !Array.isArray(param) && param.isPhantom ? "phantom " : "";
    const ability = constraints.length ? `: ${constraints.join(" + ").toLowerCase()}` : "";
    return `${phantom}${names[index]}${ability}`;
  });
  return { names, text: `<${values.join(", ")}>` };
}

function opcodeToComment(line: string): string {
  return line
    .replace(/\bCopyLoc\[(\d+)\]\(([^)]*)\)/g, "copy $2")
    .replace(/\bMoveLoc\[(\d+)\]\(([^)]*)\)/g, "move $2")
    .replace(/\bStLoc\[(\d+)\]\(([^)]*)\)/g, "$2 = pop()")
    .replace(/\bCall\b/g, "call")
    .replace(/\bRet\b/g, "return")
    .replace(/\bBrTrue\(([^)]*)\)/g, "if pop() goto $1")
    .replace(/\bBrFalse\(([^)]*)\)/g, "if !pop() goto $1")
    .replace(/\bBranch\(([^)]*)\)/g, "goto $1");
}

function readableBytecode(disassembly: string | null): string {
  if (!disassembly) return "";
  const lines = disassembly.split(/\r?\n/);
  const cleaned = lines.map((line) => {
    if (/^\s*\d+:\s/.test(line)) {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return `${indent}// ${opcodeToComment(line.trim())}`;
    }
    return line.replace(/\b0x0+([0-9a-f]+)::/gi, "0x$1::");
  });
  return cleaned.join("\n");
}

export function decompileModule(
  moduleName: string,
  packageId: string,
  normalized: NormalizedModule | null,
  disassembly: string | null,
) {
  const bytecodeFunctionCount = (
    disassembly?.match(
      /^(?:(?:public(?:\(friend\))?|entry|native)\s+)*[a-z_][A-Za-z0-9_]*(?:<[^{}]*>)?\([^)]*\)(?:\s*:[^{]+)?\s*\{/gm,
    ) ?? []
  ).length;
  if (!normalized) {
    return {
      source: readableBytecode(disassembly) || `module ${shortAddress(packageId)}::${moduleName} {\n    // Module ABI is unavailable.\n}`,
      functionCount: bytecodeFunctionCount,
      structCount: (disassembly?.match(/\bstruct\s+\w+/g) ?? []).length,
    };
  }

  const lines: string[] = [
    `// Reconstructed from on-chain ABI and bytecode. Original names/comments may be lost.`,
    `module ${shortAddress(normalized.address ?? packageId)}::${normalized.name ?? moduleName} {`,
  ];

  for (const friend of normalized.friends ?? []) {
    if (typeof friend === "string") {
      lines.push(`    friend ${friend};`);
    } else {
      const friendName = friend.module ?? friend.name ?? "unknown";
      lines.push(`    friend ${shortAddress(friend.address ?? "0x0")}::${friendName};`);
    }
  }
  if ((normalized.friends ?? []).length) lines.push("");

  const structs = Object.entries(normalized.structs ?? {});
  for (const [name, struct] of structs) {
    const generic = formatGenerics(struct.typeParameters);
    const abilities = struct.abilities?.length
      ? ` has ${struct.abilities.join(", ").toLowerCase()}`
      : "";
    lines.push(`    struct ${name}${generic.text}${abilities} {`);
    for (const field of struct.fields ?? []) {
      lines.push(`        ${field.name}: ${typeToMove(field.type, generic.names)},`);
    }
    lines.push("    }", "");
  }

  const functions = Object.entries(normalized.exposedFunctions ?? {});
  for (const [name, fn] of functions) {
    const generic = formatGenerics(fn.typeParameters);
    const visibility =
      fn.visibility === "Public" || fn.visibility === "public"
        ? "public "
        : fn.visibility?.toLowerCase().includes("friend")
          ? "public(friend) "
          : "";
    const entry = fn.isEntry ? "entry " : "";
    const params = (fn.parameters ?? [])
      .map((type, index) => `arg${index}: ${typeToMove(type, generic.names)}`)
      .join(", ");
    const returns = fn.return ?? [];
    const returnText =
      returns.length === 0
        ? ""
        : returns.length === 1
          ? `: ${typeToMove(returns[0], generic.names)}`
          : `: (${returns.map((t) => typeToMove(t, generic.names)).join(", ")})`;
    lines.push(`    ${visibility}${entry}fun ${name}${generic.text}(${params})${returnText} {`);
    lines.push("        // See the BYTECODE tab for the original on-chain instructions.");
    lines.push("        /* body reconstructed at instruction level */");
    lines.push("    }", "");
  }

  lines.push("}");
  return {
    source: lines.join("\n"),
    functionCount: Math.max(functions.length, bytecodeFunctionCount),
    structCount: structs.length,
  };
}
