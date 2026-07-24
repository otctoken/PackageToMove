type DecompilerExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  decompile: (pointer: number, length: number) => number;
  get_input_ptr: () => number;
  get_output_ptr: () => number;
  get_max_input_size: () => number;
};

let exportsPromise: Promise<DecompilerExports> | null = null;

async function loadDecompiler() {
  if (!exportsPromise) {
    exportsPromise = (async () => {
      const response = await fetch("/move_decompiler.wasm");
      if (!response.ok) {
        throw new Error(`WASM 反编译器加载失败：HTTP ${response.status}`);
      }
      let result: WebAssembly.WebAssemblyInstantiatedSource;
      try {
        result = await WebAssembly.instantiateStreaming(response.clone());
      } catch {
        result = await WebAssembly.instantiate(await response.arrayBuffer());
      }
      return result.instance.exports as DecompilerExports;
    })();
  }
  return exportsPromise;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function shortAddress(value: string) {
  const compact = value.replace(/^0+/, "");
  return `0x${compact || "0"}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandModuleAddresses(source: string, disassembly?: string | null) {
  if (!disassembly) return source;
  const imports = [
    ...disassembly.matchAll(
      /^use\s+([0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*);$/gm,
    ),
  ].map((match) => ({
    address: shortAddress(match[1].toLowerCase()),
    module: match[2],
  }));
  return imports
    .sort((a, b) => b.module.length - a.module.length)
    .reduce((current, item) => {
      const pattern = new RegExp(
        `(^|[^:A-Za-z0-9_])${escapeRegExp(item.module)}::`,
        "gm",
      );
      return current.replace(
        pattern,
        `$1${item.address}::${item.module}::`,
      );
    }, source);
}

function stripOuterParens(value: string) {
  let result = value.trim();
  while (result.startsWith("(") && result.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] === "(") depth += 1;
      if (result[index] === ")") depth -= 1;
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function recoverAssertions(source: string) {
  return source.replace(
    /^([ \t]*)if\s*\(([\s\S]*?)\)\s*\{\s*\}\s*else\s*\{\s*abort\s+(\d+);\s*\};?/gm,
    (_match, indent: string, condition: string, code: string) =>
      `${indent}assert!(${stripOuterParens(condition)}, ${code});`,
  );
}

export function polishDecompiledSource(
  source: string,
  disassembly?: string | null,
) {
  return expandModuleAddresses(recoverAssertions(source), disassembly)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function decompileMoveBytecode(
  encodedBytecode: string,
  disassembly?: string | null,
) {
  const bytecode = decodeBase64(encodedBytecode);
  const exports = await loadDecompiler();
  const maxInputSize = exports.get_max_input_size();
  if (bytecode.length > maxInputSize) {
    throw new Error(
      `模块字节码过大：${bytecode.length} bytes（上限 ${maxInputSize}）`,
    );
  }

  const inputPointer = exports.get_input_ptr();
  new Uint8Array(exports.memory.buffer).set(bytecode, inputPointer);
  const outputLength = exports.decompile(inputPointer, bytecode.length);
  if (outputLength === 0) throw new Error("WASM 反编译器没有生成源码");

  const outputPointer = exports.get_output_ptr();
  const output = new Uint8Array(
    exports.memory.buffer,
    outputPointer,
    outputLength,
  );
  return polishDecompiledSource(new TextDecoder().decode(output), disassembly);
}
