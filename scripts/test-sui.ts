import assert from "node:assert/strict";
import { dependenciesFromLinkage, normalizePackageId } from "../lib/sui";

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
