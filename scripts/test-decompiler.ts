import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { polishDecompiledSource } from "../lib/wasm-decompiler";

const input = `fun sample(arg0: u64): u64 {
        if ((arg0 > 0)) {
            let v0 = (arg0 <= 100);
        } else {
            v0 = false;
        }
        if (v0) {
            if ((arg0 > 50)) {
                let v1 = 2;
            } else {
                v1 = 1;
            }
            v1;
        } else {
            _ = arg0;
            abort 42;
        }
    }`;

const output = polishDecompiledSource(input);
assert.match(output, /assert!\(arg0 > 0 && arg0 <= 100, 42\);/);
assert.match(output, /let v1 = if \(arg0 > 50\) \{ 2 } else \{ 1 };/);
assert.match(output, /return v1;/);
assert.doesNotMatch(output, /abort 42/);

const branchAliasInput = `fun branch_alias(arg0: bool, arg1: u64, arg2: u64, arg3: u64) {
        if (arg0) {
            if ((arg1 < arg2)) {
                let v15 = true;
            } else {
                v15 = (arg1 >= arg3);
            }
            let v17 = v15;
        } else {
            if ((arg1 >= arg2)) {
                let v16 = (arg1 < arg3);
            } else {
                v16 = false;
            }
            v17 = v16;
        }
        let v18 = v17;
    }`;

const branchAliasOutput = polishDecompiledSource(branchAliasInput);
assert.match(
  branchAliasOutput,
  /let v17 = if \(arg0\) \{ arg1 < arg2 \|\| arg1 >= arg3 } else \{ arg1 >= arg2 && arg1 < arg3 };/,
);
assert.doesNotMatch(branchAliasOutput, /let v15|let v16/);

const referenceReturnInput = `public fun borrow_value(arg0: &Holder): &u64 {
        assert!(exists(arg0), 7);
        borrow_field(arg0);
    }`;
const referenceReturnOutput = polishDecompiledSource(referenceReturnInput);
assert.match(referenceReturnOutput, /borrow_field\(arg0\)\n\s*}/);
assert.doesNotMatch(referenceReturnOutput, /borrow_field\(arg0\);/);

async function testOnChainRangeFixture() {
  const [wasm, bytecode] = await Promise.all([
    readFile("public/move_decompiler.wasm"),
    readFile("vendor/move-decompiler-zig/src/test_data/range.mv"),
  ]);
  assert.equal(
    createHash("sha256").update(bytecode).digest("hex"),
    "01fcc922e020212d6d152ed7b00501569efe5c344c2f2f685799d96479414326",
  );

  const { instance } = await WebAssembly.instantiate(wasm);
  const exports = instance.exports as DecompilerExports;
  new Uint8Array(exports.memory.buffer).set(bytecode, exports.get_input_ptr());
  const outputLength = exports.decompile(
    exports.get_input_ptr(),
    bytecode.length,
  );
  const raw = new TextDecoder().decode(
    new Uint8Array(
      exports.memory.buffer,
      exports.get_output_ptr(),
      outputLength,
    ),
  );
  const output = polishDecompiledSource(raw);

  assert.equal(output.match(/\bfun\s+/g)?.length, 15);
  assert.equal(output.match(/\bassert!\(/g)?.length, 26);
  assert.equal(output.match(/\bwhile\s*\(/g)?.length, 1);
  assert.match(output, /v14\.min_stake = arg1;/);
  assert.match(output, /with_defining_ids<T0>\(\)/);
  assert.match(output, /Parameters<T0> \{/);
  assert.match(output, /event::emit<RangeParametersSetEvent<T0>>/);
  assert.match(output, /let v61 = v59\[v27\];/);
  assert.match(
    output,
    /let v17 = if \(arg6\) \{ v57 < arg4 \|\| v57 >= arg5 } else \{ v57 >= arg4 && v57 < arg5 };/,
  );
  assert.doesNotMatch(output, /\*arg1\s*=/);
  assert.doesNotMatch(output, /\bfreeze\(/);
  assert.doesNotMatch(output, /let v15 = true|v17 = v16/);
  assert.doesNotMatch(output, /\?\?\?|\/\*[^*]*\?[^*]*\*\//);
}

type DecompilerExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  decompile: (pointer: number, length: number) => number;
  get_input_ptr: () => number;
  get_output_ptr: () => number;
};

testOnChainRangeFixture()
  .then(() => console.log("Decompiler refinement tests passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
