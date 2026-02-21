import assert from "node:assert/strict";
import { runBridge } from "./runBridge";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run() {
  const originalFetch = global.fetch;

  process.env.LLM_PROVIDER = "qwen";
  process.env.QWEN_API_KEY = "test-key";
  process.env.QWEN_BASE_URL = "https://mock-llm.local/v1";

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/chat/completions")) {
      const patch = {
        app: ["E-RD-001"],
        core_loop: ["E-RD-001"],
        screens: { main: ["E-RD-001"] },
        commands: { save_item: ["E-RD-001"] },
        tables: { items: ["E-RD-001"] },
        acceptance_tests: { "0": ["E-RD-001"] },
      };
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(patch) } }],
      });
    }
    return jsonResponse({}, 500);
  }) as typeof fetch;

  try {
    const wireRaw = {
      app: { name: "Demo App", one_sentence: "Demo", inspired_by: null },
      core_loop: "Input -> process -> SQLite -> display",
      screens: [{ id: "main", name: "Main", purpose: "P", primary_actions: ["Run"] }],
      rust_commands: [{ name: "save_item", purpose: "Save", async: true, input: {}, output: {} }],
      data_model: { tables: [{ name: "items", fields: [{ name: "id", type: "TEXT" }] }] },
      mvp_plan: { milestones: [{ week: 1, tasks: ["Task"] }] },
      acceptance_tests: ["it works"],
      open_questions: [],
      scores: {
        closure: 3,
        feasibility: 3,
        stack_fit: 3,
        complexity_control: 3,
        debuggability: 3,
        demo_value: 3,
      },
      overall_recommendation: "go",
      citations: {},
      tauri_capabilities: [],
    };

    const out = await runBridge({
      repo: "owner/repo",
      run_id: "run1",
      generated_at: "2026-01-01T00:00:00.000Z",
      source_repo: { full_name: "owner/repo", url: "https://github.com/owner/repo" },
      topics: ["rust"],
      wireRaw,
      allowedEvidenceIds: ["E-RD-001"],
      evidenceLines: ['[ID:E-RD-001] (readme) TITLE="README" URL=https://github.com/owner/repo EXCERPT="x"'],
      provider: "qwen",
      model: "qwen3-max-2026-01-23",
      temperature: 0.2,
      maxRepairAttempts: 1,
      iter: 1,
    });

    assert.equal(out.ok, true);
    assert.ok(out.canonical);
    // canonical output is now Forge-compatible and minimal
    assert.equal(out.canonical?.schema_version, 3);
    assert.ok(out.canonical?.app.one_liner);
    // no cover/repair stages in v3
    assert.ok(!(out.report.stages || []).some((s) => s.name === "cover"));
  } finally {
    global.fetch = originalFetch;
  }
}

void run().then(() => console.log("runBridge.test.ts passed"));
