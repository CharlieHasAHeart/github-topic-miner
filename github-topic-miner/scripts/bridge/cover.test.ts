import assert from "node:assert/strict";
import { ensureCitationCoverage } from "./cover";
import type { CanonicalSpec } from "./canonicalSchemas";

const base: CanonicalSpec = {
  schema_version: 3,
  app: { name: "App", one_liner: "desc" },
  screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
  rust_commands: [{ name: "sync", purpose: "p", async: true, input: {}, output: {} }],
  data_model: { tables: [{ name: "items", columns: [{ name: "id", type: "TEXT" }] }] },
  mvp_plan: ["week 1: t"],
  acceptance_tests: ["t1"],
};

const out = ensureCitationCoverage(base);
assert.equal(out.ok, true);
assert.deepEqual(out.missing, []);

console.log("cover.test.ts passed");
