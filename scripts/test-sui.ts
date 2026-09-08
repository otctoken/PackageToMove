import assert from "node:assert/strict";
import { analyzePackage, dependenciesFromLinkage, normalizePackageId } from "../lib/sui";
import { getMoveModuleBytecode } from "../lib/bytecode";

const root = normalizePackageId(
  "0x47c4b62aed92c5ae308ecd00253b64b3568ad97e6fb11e54b3d1ac5ed7be19ab",
);
const dependencies = dependenciesFromLinkage(
  [
    { upgradedId: "0x1" },
    { upgradedId: "0x2" },
    { upgradedId: "0x2" },
    { upgradedId: root },
    { upgradedId: "not-an-address" },
  ],
  root,
);

assert.deepEqual(dependencies, [
  normalizePackageId("0x1"),
  normalizePackageId("0x2"),
]);

console.log("Sui linkage dependency tests passed.");

async function exactPackageTests() {
  const originalFetch = globalThis.fetch;
  const id = normalizePackageId("0xac55259d62fd8c30dd638f46afab109bc6a1066c4e92093b791d60e6bad266e7");
  let returnedAddress = id;
  let paginate = false;
  let drift = false;
  globalThis.fetch = async (_url, options) => {
    const { query, variables } = JSON.parse(String(options?.body));
    assert.match(query, /object\(address: \$address/);
    assert.match(query, /asMovePackage/);
    assert.doesNotMatch(query, /\bpackage\(address:/);
    if (paginate && variables.after) assert.equal(variables.version, 1);
    const next = paginate && !variables.after;
    return Response.json({ data: { object: { package: {
      address: returnedAddress, version: drift && variables.after ? 2 : 1, digest: "exact-object", linkage: [],
      module: { name: "session", bytes: "AQID" },
      modules: { nodes: paginate ? [{name:next ? "ll" : "session", bytes:"AQID"}] :
        [{ name: "ll", bytes: "AQID" }, { name: "session", bytes: "AQID" }],
        pageInfo: { hasNextPage: next, endCursor: next ? "page2" : null } },
    } } } });
  };
  try {
    const result = await analyzePackage(id, "mainnet");
    assert.deepEqual(result.packages[0].modules.map((m) => m.name), ["ll", "session"]);
    assert.equal((await getMoveModuleBytecode(id, "session", "mainnet")).bytecode, "AQID");
    paginate = true;
    assert.deepEqual((await analyzePackage(id,"mainnet")).packages[0].modules.map(m=>m.name), ["ll","session"]);
    drift = true;
    await assert.rejects(analyzePackage(id,"mainnet"), /版本不匹配/);
    paginate = false;
    drift = false;
    returnedAddress = normalizePackageId("0x2db4bc4a188101d82f985cc2f77bc27f9f94f68911bbed2087c75d679f1e3d22");
    await assert.rejects(analyzePackage(id, "mainnet"), /地址不匹配/);
    await assert.rejects(getMoveModuleBytecode(id, "session", "mainnet"), /地址不匹配/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("Exact immutable package identity tests passed.");
}
void exactPackageTests();
