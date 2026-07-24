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

function findMatchingDelimiter(
  source: string,
  start: number,
  open: string,
  close: string,
) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function abortOnly(body: string) {
  const statements = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^_\s*=\s*.+;$/.test(line));
  if (statements.length !== 1) return null;
  return statements[0].match(/^abort\s+(\d+);$/)?.[1] ?? null;
}

function dedentBranch(body: string, indent: string) {
  const branchIndent = `${indent}    `;
  return body
    .replace(/^\s*\n/, "")
    .replace(/\n\s*$/, "")
    .split("\n")
    .map((line) =>
      line.startsWith(branchIndent) ? `${indent}${line.slice(branchIndent.length)}` : line,
    )
    .join("\n");
}

function singleAssignment(body: string) {
  let compact = body.trim();
  const alias = compact.match(
    /^let\s+(v\d+)\s*=\s*([^\n;]+);\s*\n\s*(let\s+)?(v\d+)\s*=\s*\1;$/,
  );
  if (alias) {
    compact = `${alias[3] ?? ""}${alias[4]} = ${alias[2]};`;
  }
  const match = compact.match(/^(let\s+)?(v\d+)\s*=\s*([\s\S]*);$/);
  if (!match || match[3].includes("\n")) return null;
  return {
    declared: Boolean(match[1]),
    variable: match[2],
    expression: match[3].trim(),
  };
}

function conditionalExpression(
  condition: string,
  thenExpression: string,
  elseExpression: string,
) {
  if (thenExpression === "true") {
    return `${stripOuterParens(condition)} || ${stripOuterParens(elseExpression)}`;
  }
  if (elseExpression === "false") {
    return `${stripOuterParens(condition)} && ${stripOuterParens(thenExpression)}`;
  }
  return `if (${condition}) { ${thenExpression} } else { ${elseExpression} }`;
}

function simplifyStructuredControlFlow(source: string): string {
  let cursor = 0;
  let output = "";

  while (cursor < source.length) {
    const match = /(^|\n)([ \t]*)if\s*\(/g.exec(source.slice(cursor));
    if (!match) {
      output += source.slice(cursor);
      break;
    }

    const matchStart = cursor + match.index;
    const lineBreakLength = match[1].length;
    const indent = match[2];
    const ifStart = matchStart + lineBreakLength + indent.length;
    output += source.slice(cursor, ifStart);

    const conditionStart = source.indexOf("(", ifStart) + 1;
    const conditionEnd = findMatchingDelimiter(source, conditionStart - 1, "(", ")");
    if (conditionStart === 0 || conditionEnd < 0) {
      output += source.slice(ifStart, ifStart + 2);
      cursor = ifStart + 2;
      continue;
    }

    const thenOpen = source.indexOf("{", conditionEnd);
    if (thenOpen < 0) {
      output += source.slice(ifStart, conditionEnd + 1);
      cursor = conditionEnd + 1;
      continue;
    }
    const thenClose = findMatchingDelimiter(source, thenOpen, "{", "}");
    if (thenClose < 0) {
      output += source.slice(ifStart);
      break;
    }

    let afterThen = thenClose + 1;
    while (/\s/.test(source[afterThen] ?? "")) afterThen += 1;
    if (!source.startsWith("else", afterThen)) {
      const thenBody = simplifyStructuredControlFlow(
        source.slice(thenOpen + 1, thenClose),
      );
      output += `${source.slice(ifStart, thenOpen + 1)}${thenBody}}`;
      cursor = thenClose + 1;
      continue;
    }

    const elseOpen = source.indexOf("{", afterThen + 4);
    const elseClose =
      elseOpen >= 0 ? findMatchingDelimiter(source, elseOpen, "{", "}") : -1;
    if (elseOpen < 0 || elseClose < 0) {
      output += source.slice(ifStart, thenClose + 1);
      cursor = thenClose + 1;
      continue;
    }

    const condition = stripOuterParens(
      source.slice(conditionStart, conditionEnd),
    );
    const thenBody = simplifyStructuredControlFlow(
      source.slice(thenOpen + 1, thenClose),
    );
    const elseBody = simplifyStructuredControlFlow(
      source.slice(elseOpen + 1, elseClose),
    );
    const thenAbort = abortOnly(thenBody);
    const elseAbort = abortOnly(elseBody);

    if (elseAbort) {
      const continuation = dedentBranch(thenBody, indent);
      output += `assert!(${condition}, ${elseAbort});`;
      if (continuation) output += `\n${continuation}`;
    } else if (thenAbort) {
      const continuation = dedentBranch(elseBody, indent);
      output += `assert!(!(${condition}), ${thenAbort});`;
      if (continuation) output += `\n${continuation}`;
    } else {
      const thenAssignment = singleAssignment(thenBody);
      const elseAssignment = singleAssignment(elseBody);
      if (
        thenAssignment &&
        elseAssignment &&
        thenAssignment.variable === elseAssignment.variable
      ) {
        output += `let ${thenAssignment.variable} = ${conditionalExpression(
          condition,
          thenAssignment.expression,
          elseAssignment.expression,
        )};`;
      } else {
        output += `if (${source.slice(conditionStart, conditionEnd).trim()}) {${thenBody}} else {${elseBody}}`;
      }
    }
    cursor = elseClose + 1;
  }

  return output;
}

function recoverAssertions(source: string) {
  const simplified = simplifyStructuredControlFlow(source);
  let result = simplified.replace(
      /^([ \t]*)if\s*\(([\s\S]*?)\)\s*\{\s*\}\s*else\s*\{\s*abort\s+(\d+);\s*\};?/gm,
      (_match, indent: string, condition: string, code: string) =>
        `${indent}assert!(${stripOuterParens(condition)}, ${code});`,
    )
    .replace(/^([ \t]*)}\s*else\s*\{\s*}\s*$/gm, "$1}")
    .replace(
      /^([ \t]*)let (v\d+) = if \((.+)\) \{ (.+) } else \{ false };\n\1assert!\(\2, (\d+)\);$/gm,
      (_match, indent: string, _variable: string, left: string, right: string, code: string) =>
        `${indent}assert!(${stripOuterParens(left)} && ${stripOuterParens(right)}, ${code});`,
    )
    .replace(
      /^([ \t]*)let (v\d+) = if \((.+)\) \{ true } else \{ (.+) };\n\1assert!\(\2, (\d+)\);$/gm,
      (_match, indent: string, _variable: string, left: string, right: string, code: string) =>
        `${indent}assert!(${stripOuterParens(left)} || ${stripOuterParens(right)}, ${code});`,
    )
    .replace(
      /^([ \t]*)let (v\d+) = (.+);\n\1assert!\(\2, (\d+)\);$/gm,
      (_match, indent: string, _variable: string, expression: string, code: string) =>
        `${indent}assert!(${stripOuterParens(expression)}, ${code});`,
    );

  // When terminating abort arms were lifted out of nested branches, the Zig
  // printer may have already emitted the return value as a semicolon-terminated
  // statement. Make that return explicit and valid Move.
  result = result.replace(
    /^ {8}(v\d+);\n {4}}$/gm,
    "        return $1;\n    }",
  );
  return result;
}

function recoverFunctionTailExpressions(source: string) {
  let cursor = 0;
  let output = "";

  while (cursor < source.length) {
    const functionMatch = /\bfun\s+[A-Za-z_][A-Za-z0-9_]*(?:<[^>{}]*>)?\s*\(/g.exec(
      source.slice(cursor),
    );
    if (!functionMatch) {
      output += source.slice(cursor);
      break;
    }

    const functionStart = cursor + functionMatch.index;
    const bodyOpen = source.indexOf("{", functionStart);
    if (bodyOpen < 0) {
      output += source.slice(cursor);
      break;
    }
    const bodyClose = findMatchingDelimiter(source, bodyOpen, "{", "}");
    if (bodyClose < 0) {
      output += source.slice(cursor);
      break;
    }

    output += source.slice(cursor, bodyOpen + 1);
    let body = source.slice(bodyOpen + 1, bodyClose);
    const header = source.slice(functionStart, bodyOpen);
    const hasReturnType = /\)\s*:\s*[\s\S]+$/.test(header);

    if (hasReturnType) {
      const tail = body.match(/(^|\n)([ \t]*)([^\n;]+);([ \t]*\n?[ \t]*)$/);
      if (tail) {
        const expression = tail[3].trim();
        if (
          !/^(?:return|abort|let|assert!|continue|break)\b/.test(expression) &&
          !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(expression)
        ) {
          body = `${body.slice(0, tail.index)}${tail[1]}${tail[2]}${tail[3]}${tail[4]}`;
        }
      }
    }

    output += body;
    output += "}";
    cursor = bodyClose + 1;
  }

  return output;
}

export function polishDecompiledSource(
  source: string,
  disassembly?: string | null,
) {
  return expandModuleAddresses(
    recoverFunctionTailExpressions(recoverAssertions(source)),
    disassembly,
  )
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
