import assert from "node:assert/strict";
import { normalizeWireToCanonical } from "./normalize";

function normalize(wire: unknown) {
  return normalizeWireToCanonical({
    wire: wire as any,
    run_id: "r1",
    generated_at: "2026-01-01T00:00:00.000Z",
    source_repo: { full_name: "o/r", url: "https://github.com/o/r" },
    topics: [],
  }).canonical;
}

{
  const canonical = normalize({
    app: { name: "A", one_liner: "B", inspired_by: "legacy" },
    core_loop: "legacy",
    screens: [{ id: "x", name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [{ name: "cmd", purpose: "p", async: true, input: { a: 1 }, output: { b: 2 } }],
    data_model: { tables: [{ name: "t", columns: [{ name: "id", type: "int", notes: "legacy" }] }] },
    mvp_plan: ["task"],
    acceptance_tests: ["ok"],
    citations: { app: ["E-1"] },
  });
  assert.deepEqual(
    Object.keys(canonical).sort(),
    ["acceptance_tests", "app", "data_model", "mvp_plan", "rust_commands", "schema_version", "screens"].sort(),
    "RULE:field_set_minimal top-level keys must match schema v3 minimal",
  );
}

{
  const canonical = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [
      { name: "c1", purpose: "p", async: true, input: null, output: {} },
      { name: "c2", purpose: "p", async: true, input: "", output: [] },
      {
        name: "c3",
        purpose: "save item",
        async: true,
        input: { placeholder: true },
        output: { placeholder: "todo" },
      },
    ],
    data_model: { tables: [{ name: "t", columns: [{ name: "id", type: "text" }, { name: "title", type: "text" }] }] },
    mvp_plan: ["task"],
    acceptance_tests: ["ok"],
  });
  for (const cmd of canonical.rust_commands) {
    assert.equal(typeof cmd.input, "object", "RULE:command_io_non_empty input must be object");
    assert.equal(Array.isArray(cmd.input), false, "RULE:command_io_non_empty input must not be array");
    assert.ok(Object.keys(cmd.input as Record<string, unknown>).length > 0, "RULE:command_io_non_empty input non-empty");
    assert.equal(
      Object.keys(cmd.input as Record<string, unknown>).includes("placeholder"),
      false,
      "RULE:command_io_non_empty input placeholder removed",
    );

    assert.equal(typeof cmd.output, "object", "RULE:command_io_non_empty output must be object");
    assert.equal(Array.isArray(cmd.output), false, "RULE:command_io_non_empty output must not be array");
    assert.ok(
      Object.keys(cmd.output as Record<string, unknown>).length > 0,
      "RULE:command_io_non_empty output non-empty",
    );
    assert.equal(
      Object.keys(cmd.output as Record<string, unknown>).includes("placeholder"),
      false,
      "RULE:command_io_non_empty output placeholder removed",
    );
  }
}

{
  const canonical = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [
      { name: "Main", purpose: "p", primary_actions: ["run"] },
      { name: "Main", purpose: "p2", primary_actions: ["run"] },
    ],
    rust_commands: [
      { name: "save", purpose: "p", async: true, input: { a: 1 }, output: { b: 1 } },
      { name: "save", purpose: "p2", async: true, input: { a: 2 }, output: { b: 2 } },
    ],
    data_model: {
      tables: [
        { name: "items", columns: [{ name: "id", type: "int" }, { name: "id", type: "text" }] },
        { name: "items", columns: [{ name: "id", type: "int" }] },
      ],
    },
    mvp_plan: ["task"],
    acceptance_tests: ["ok"],
  });
  assert.equal(new Set(canonical.screens.map((x) => x.name)).size, canonical.screens.length, "RULE:name_unique screens");
  assert.equal(
    new Set(canonical.rust_commands.map((x) => x.name)).size,
    canonical.rust_commands.length,
    "RULE:name_unique commands",
  );
  assert.equal(
    new Set(canonical.data_model.tables.map((x) => x.name)).size,
    canonical.data_model.tables.length,
    "RULE:name_unique tables",
  );
  for (const table of canonical.data_model.tables) {
    assert.equal(
      new Set(table.columns.map((x) => x.name)).size,
      table.columns.length,
      `RULE:name_unique columns table=${table.name}`,
    );
  }
}

{
  const canonical = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [{ name: "c", purpose: "p", async: true, input: { a: 1 }, output: { b: 1 } }],
    data_model: {
      tables: [
        {
          name: "t",
          columns: [
            { name: "a", type: "int" },
            { name: "b", type: "boolean" },
            { name: "c", type: "jsonb" },
            { name: "d", type: "timestamp" },
            { name: "e", type: "varchar" },
          ],
        },
      ],
    },
    mvp_plan: ["task"],
    acceptance_tests: ["ok"],
  });
  const colTypes = Object.fromEntries(canonical.data_model.tables[0].columns.map((c) => [c.name, c.type]));
  assert.equal(colTypes.a, "INTEGER", "RULE:column_type_normalized int->INTEGER");
  assert.equal(colTypes.b, "BOOLEAN", "RULE:column_type_normalized boolean->BOOLEAN");
  assert.equal(colTypes.c, "JSON", "RULE:column_type_normalized jsonb->JSON");
  assert.equal(colTypes.d, "DATETIME", "RULE:column_type_normalized timestamp->DATETIME");
  assert.equal(colTypes.e, "TEXT", "RULE:column_type_normalized varchar->TEXT");
}

{
  const canonical = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [
      { name: "z", purpose: "p", primary_actions: ["run", "open", "run"] },
      { name: "a", purpose: "p", primary_actions: ["submit", "analyze"] },
    ],
    rust_commands: [
      { name: "z_cmd", purpose: "p", async: true, input: { a: 1 }, output: { b: 1 } },
      { name: "a_cmd", purpose: "p", async: true, input: { a: 1 }, output: { b: 1 } },
    ],
    data_model: {
      tables: [
        { name: "z_table", columns: [{ name: "z_col", type: "int" }, { name: "a_col", type: "text" }] },
        { name: "a_table", columns: [{ name: "z_col", type: "int" }, { name: "a_col", type: "text" }] },
      ],
    },
    mvp_plan: ["week 2: b", "week 1: a"],
    acceptance_tests: ["z test", "a test"],
  });
  assert.deepEqual(
    canonical.screens.map((x) => x.name),
    ["a", "z"],
    "RULE:stable_sort screens must be ordered by name",
  );
  assert.deepEqual(
    canonical.rust_commands.map((x) => x.name),
    ["a_cmd", "z_cmd"],
    "RULE:stable_sort rust_commands must be ordered by name",
  );
  assert.deepEqual(
    canonical.data_model.tables.map((x) => x.name),
    ["a_table", "z_table"],
    "RULE:stable_sort tables must be ordered by name",
  );
  assert.deepEqual(canonical.mvp_plan, ["week 1: a", "week 2: b"], "RULE:stable_sort mvp_plan");
  assert.deepEqual(canonical.acceptance_tests, ["a test", "z test"], "RULE:stable_sort acceptance_tests");
}

console.log("normalize.rules.test.ts passed");
