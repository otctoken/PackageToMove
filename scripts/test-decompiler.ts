import assert from "node:assert/strict";
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

console.log("Decompiler refinement tests passed.");
