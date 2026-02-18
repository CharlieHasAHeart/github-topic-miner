import assert from "node:assert/strict";
import { applyCitationsPatch, computeMissingCitationKeys } from "./patchOps";
import type { CanonicalSpec } from "./canonicalSchemas";

const base: CanonicalSpec = {
  schema_version: 1,
  meta: {
    run_id: "r1",
    generated_at: "2026-01-01T00:00:00.000Z",
    source_repo: { full_name: "o/r", url: "https://github.com/o/r" },
    topics: [],
  },
  app: { name: "A", one_sentence: "B", inspired_by: null },
  core_loop: "x",
  screens: [{ id: "main", name: "Main", purpose: "p", primary_actions: ["a"] }],
  rust_commands: [{ name: "save", purpose: "p", async: true, input: {}, output: {} }],
  data_model: { tables: [{ name: "items", fields: [{ name: "id", type: "TEXT" }] }] },
  tauri_capabilities: [],
  mvp_plan: { milestones: [{ week: 1, tasks: ["t"] }] },
  acceptance_tests: ["test1"],
  open_questions: [],
  scores: {
    closure: 1,
    feasibility: 1,
    stack_fit: 1,
    complexity_control: 1,
    debuggability: 1,
    demo_value: 1,
  },
  overall_recommendation: "hold",
  citations: {
    app: [],
    core_loop: [],
    screens: { main: [] },
    commands: { save: [] },
    tables: { items: [] },
    acceptance_tests: { "0": [] },
  },
};

const patched = applyCitationsPatch(base, {
  app: ["E-RD-001", "E-RD-001"],
  commands: { save: ["E-IS-001"] },
});

assert.equal(patched.app.name, base.app.name);
assert.deepEqual(patched.screens, base.screens);
assert.deepEqual(patched.data_model, base.data_model);
assert.deepEqual(patched.citations.app, ["E-RD-001"]);
assert.deepEqual(patched.citations.commands.save, ["E-IS-001"]);
assert.deepEqual(patched.citations.tables.items, []);

const missing = computeMissingCitationKeys(patched, true);
assert.ok(missing.includes("core_loop"));
assert.ok(missing.includes("screen:main"));
assert.ok(!missing.includes("app"));
assert.ok(!missing.includes("command:save"));

console.log("patchOps.test.ts passed");
