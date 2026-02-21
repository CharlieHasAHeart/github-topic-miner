import assert from "node:assert/strict";
import { applyCitationsPatch, computeMissingCitationKeys } from "./patchOps";
import type { CanonicalSpec } from "./canonicalSchemas";

const base: CanonicalSpec = {
  schema_version: 3,
  app: { name: "A", one_liner: "B" },
  screens: [{ name: "Main", purpose: "p", primary_actions: ["a"] }],
  rust_commands: [{ name: "save", purpose: "p", async: true, input: {}, output: {} }],
  data_model: { tables: [{ name: "items", columns: [{ name: "id", type: "TEXT" }] }] },
  mvp_plan: ["week 1: t"],
  acceptance_tests: ["test1"],
};

assert.deepEqual(computeMissingCitationKeys(base), []);
assert.deepEqual(applyCitationsPatch(base), base);

console.log("patchOps.test.ts passed");
