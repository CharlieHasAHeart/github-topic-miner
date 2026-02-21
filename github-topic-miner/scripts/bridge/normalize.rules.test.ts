import assert from "node:assert/strict";
import { CanonicalSpecSchema } from "./canonicalSchemas";
import { normalizeWireToCanonical } from "./normalize";

function normalize(wire: unknown) {
  return normalizeWireToCanonical({
    wire: wire as any,
    run_id: "r1",
    generated_at: "2026-01-01T00:00:00.000Z",
    source_repo: { full_name: "o/r", url: "https://github.com/o/r" },
    topics: [],
  });
}

{
  const { canonical } = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [
      {
        name: "run_command",
        purpose: "execute",
        async: true,
        input: { request: { file_path: "", valid: false } },
        output: { request: { result: {}, count: 1 } },
      },
    ],
    data_model: { tables: [{ name: "items", columns: [{ name: "id", type: "TEXT" }] }] },
    mvp_plan: ["week 1: x"],
    acceptance_tests: ["ok"],
  });
  assert.deepEqual(
    canonical.rust_commands[0].input,
    { file_path: "string", valid: "boolean" },
    "RULE:request_strip_and_typeify input request wrapper should be stripped and values converted",
  );
  assert.deepEqual(
    canonical.rust_commands[0].output,
    { count: "int", result: "json" },
    "RULE:request_strip_and_typeify output request wrapper should be stripped and values converted",
  );
  assert.equal("request" in canonical.rust_commands[0].input, false, "RULE:request_removed input");
  assert.equal("request" in canonical.rust_commands[0].output, false, "RULE:request_removed output");
}

{
  const { canonical } = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [
      { name: "save_item", purpose: "save", async: true, input: {}, output: {} },
      {
        name: "sync_item",
        purpose: "sync",
        async: true,
        input: { placeholder: true },
        output: { todo: "later" },
      },
    ],
    data_model: { tables: [{ name: "items", columns: [{ name: "title", type: "TEXT" }] }] },
    mvp_plan: ["week 1: x"],
    acceptance_tests: ["ok"],
  });
  for (const cmd of canonical.rust_commands) {
    assert.ok(Object.keys(cmd.input).length > 0, `RULE:io_non_empty ${cmd.name}.input`);
    assert.ok(Object.keys(cmd.output).length > 0, `RULE:io_non_empty ${cmd.name}.output`);
    assert.equal(
      Object.keys(cmd.input).some((k) => k === "request" || k === "placeholder" || k === "todo"),
      false,
      `RULE:no_placeholder_or_request ${cmd.name}.input`,
    );
    assert.equal(
      Object.keys(cmd.output).some((k) => k === "request" || k === "placeholder" || k === "todo"),
      false,
      `RULE:no_placeholder_or_request ${cmd.name}.output`,
    );
  }
}

{
  const { canonical } = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [
      { name: "lint_config", purpose: "lint", async: true, input: null, output: null },
      { name: "apply_fixes", purpose: "apply", async: true, input: {}, output: {} },
    ],
    data_model: { tables: [{ name: "items", columns: [{ name: "id", type: "TEXT" }] }] },
    mvp_plan: ["week 1: x"],
    acceptance_tests: ["ok"],
  });
  const lint = canonical.rust_commands.find((x) => x.name === "lint_config");
  const apply = canonical.rust_commands.find((x) => x.name === "apply_fixes");
  assert.ok(lint, "RULE:template lint command exists");
  assert.ok(apply, "RULE:template apply command exists");
  assert.deepEqual(
    lint!.input,
    { file_path: "string", tool_type: "string?" },
    "RULE:template lint input",
  );
  assert.deepEqual(
    lint!.output,
    { diagnostics: "json?", message: "string?", ok: "boolean" },
    "RULE:template lint output",
  );
  assert.deepEqual(
    apply!.input,
    { file_path: "string", fix_ids: "json?" },
    "RULE:template apply input",
  );
  assert.deepEqual(
    apply!.output,
    { changed: "boolean?", diff: "string?", message: "string?", ok: "boolean" },
    "RULE:template apply output",
  );
}

{
  const { canonical } = normalize({
    app: { name: "A", one_liner: "B" },
    screens: [{ name: "Main", purpose: "p", primary_actions: ["run"] }],
    rust_commands: [{ name: "x", purpose: "p", async: true, input: { n: 1 }, output: { ok: true } }],
    data_model: { tables: [{ name: "t", columns: [{ name: "id", type: "TEXT" }] }] },
    mvp_plan: ["week 1: x"],
    acceptance_tests: ["ok"],
  });
  assert.doesNotThrow(
    () => CanonicalSpecSchema.parse(canonical),
    "RULE:canonical_schema_v3 parse should pass with command io dictionary types",
  );
}

console.log("normalize.rules.test.ts passed");
