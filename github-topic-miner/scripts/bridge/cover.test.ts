import assert from "node:assert/strict";
import { ensureCitationCoverage } from "./cover";
import type { CanonicalSpec } from "./canonicalSchemas";

const base: CanonicalSpec = {
  schema_version: 1,
  meta: {
    run_id: "r1",
    generated_at: "2026-01-01T00:00:00.000Z",
    source_repo: { full_name: "owner/repo", url: "https://github.com/owner/repo" },
    topics: ["rust"],
  },
  app: { name: "App", one_sentence: "desc", inspired_by: null },
  core_loop: "loop",
  screens: [{ id: "main", name: "Main", purpose: "p", primary_actions: ["run"] }],
  rust_commands: [{ name: "sync", purpose: "p", async: true, input: {}, output: {} }],
  data_model: { tables: [{ name: "items", fields: [{ name: "id", type: "TEXT" }] }] },
  tauri_capabilities: [],
  mvp_plan: { milestones: [{ week: 1, tasks: ["t"] }] },
  acceptance_tests: ["t1"],
  open_questions: [],
  scores: {
    closure: 3,
    feasibility: 3,
    stack_fit: 3,
    complexity_control: 3,
    debuggability: 3,
    demo_value: 3,
  },
  overall_recommendation: "hold",
  citations: {
    app: [],
    core_loop: [],
    screens: {},
    commands: {},
    tables: {},
    acceptance_tests: {},
  },
};

const covered = ensureCitationCoverage(base);
assert.equal(covered.canonical.citations.app.length, 0);
assert.equal(covered.canonical.citations.core_loop.length, 0);
assert.deepEqual(covered.canonical.citations.screens.main, []);
assert.deepEqual(covered.canonical.citations.commands.sync, []);
assert.deepEqual(covered.canonical.citations.tables.items, []);
assert.deepEqual(covered.canonical.citations.acceptance_tests["0"], []);
assert.ok(covered.addedKeys.includes("screen:main"));
assert.ok(covered.addedKeys.includes("command:sync"));
assert.ok(covered.addedKeys.includes("table:items"));
assert.ok(covered.addedKeys.includes("acceptance_test:0"));

console.log("cover.test.ts passed");
