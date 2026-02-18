import type { CanonicalSpec } from "./canonicalSchemas";
import type { WireSpec } from "./wireSchemas";

interface NormalizeParams {
  wire: WireSpec;
  run_id: string;
  generated_at: string;
  source_repo: { full_name: string; url: string };
  topics: string[];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(5, Math.trunc(value)));
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return Math.max(0, Math.min(5, Math.trunc(n)));
    }
  }
  return fallback;
}

function dedupeSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function parseCitationKey(
  key: string,
):
  | { field: "app" | "core_loop"; name?: undefined }
  | { field: "screens" | "commands" | "tables" | "acceptance_tests"; name: string }
  | null {
  if (key === "app" || key === "core_loop") {
    return { field: key };
  }
  if (key.startsWith("screen:")) return { field: "screens", name: key.slice("screen:".length) };
  if (key.startsWith("command:")) return { field: "commands", name: key.slice("command:".length) };
  if (key.startsWith("table:")) return { field: "tables", name: key.slice("table:".length) };
  if (key.startsWith("acceptance_test:")) {
    return { field: "acceptance_tests", name: key.slice("acceptance_test:".length) };
  }
  return null;
}

export function normalizeWireToCanonical(
  params: NormalizeParams,
): { canonical: CanonicalSpec; normalize_report: { fixes: string[]; warnings: string[] } } {
  const { wire, run_id, generated_at, source_repo, topics } = params;
  const fixes: string[] = [];
  const warnings: string[] = [];

  const app = {
    name: asString(wire.app?.name, "Untitled App"),
    one_sentence: asString(wire.app?.one_sentence, "A desktop app generated from repository evidence."),
    inspired_by: wire.app?.inspired_by ?? null,
  };

  const core_loop = asString(
    wire.core_loop,
    "Input -> process -> SQLite persistence -> display/export",
  );

  const screens = (wire.screens ?? [])
    .map((item, idx) => {
      if (typeof item === "string") {
        return {
          id: `screen_${idx + 1}`,
          name: item,
          purpose: item,
          primary_actions: ["Open", "Run"],
        };
      }
      return {
        id: asString(item.id, `screen_${idx + 1}`),
        name: asString(item.name, `Screen ${idx + 1}`),
        purpose: asString(item.purpose, "Main workflow screen"),
        primary_actions: Array.isArray(item.primary_actions)
          ? item.primary_actions.filter((x): x is string => typeof x === "string")
          : ["Open", "Run"],
      };
    })
    .filter((item) => item.id && item.name);

  if (screens.length === 0) {
    screens.push({
      id: "main",
      name: "Main",
      purpose: "Primary workflow screen",
      primary_actions: ["Input", "Run", "Export"],
    });
    fixes.push("screens defaulted to single main screen");
  }

  const rust_commands = (wire.rust_commands ?? [])
    .map((item, idx) => {
      if (typeof item === "string") {
        return {
          name: `cmd_${idx + 1}`,
          purpose: item,
          async: true,
          input: {},
          output: {},
        };
      }
      return {
        name: asString(item.name, `cmd_${idx + 1}`),
        purpose: asString(item.purpose, "Execute core operation"),
        async: typeof item.async === "boolean" ? item.async : true,
        input: item.input ?? {},
        output: item.output ?? {},
      };
    })
    .filter((item) => item.name);
  if (rust_commands.length === 0) {
    rust_commands.push({
      name: "run_main_flow",
      purpose: "Execute core flow",
      async: true,
      input: {},
      output: {},
    });
    fixes.push("rust_commands defaulted to run_main_flow");
  }

  const tables = (wire.data_model?.tables ?? [])
    .map((item, idx) => {
      if (typeof item === "string") {
        return {
          name: item,
          fields: [{ name: "id", type: "TEXT" }],
          indexes: [],
        };
      }
      const fields = (item.fields ?? [])
        .map((f) => ({
          name: asString(f.name, "field"),
          type: asString(f.type, "TEXT"),
          ...(typeof f.notes === "string" ? { notes: f.notes } : {}),
        }))
        .filter((f) => f.name && f.type);
      return {
        name: asString(item.name, `table_${idx + 1}`),
        fields: fields.length > 0 ? fields : [{ name: "id", type: "TEXT" }],
        indexes: Array.isArray(item.indexes)
          ? item.indexes.filter((x): x is string => typeof x === "string")
          : undefined,
      };
    })
    .filter((t) => t.name);
  if (tables.length === 0) {
    tables.push({
      name: "records",
      fields: [
        { name: "id", type: "TEXT" },
        { name: "created_at", type: "TEXT" },
      ],
      indexes: undefined,
    });
    fixes.push("data_model.tables defaulted to records");
  }

  const tauri_capabilities = Array.isArray(wire.tauri_capabilities)
    ? wire.tauri_capabilities.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (Array.isArray(item)) return item.filter((x): x is string => typeof x === "string");
        return [];
      })
    : [];

  const milestones = (wire.mvp_plan?.milestones ?? [])
    .map((m, idx) => ({
      week: typeof m.week === "number" ? Math.max(1, Math.trunc(m.week)) : Number(m.week) || idx + 1,
      tasks: Array.isArray(m.tasks) ? m.tasks.filter((x): x is string => typeof x === "string") : [],
    }))
    .filter((m) => m.tasks.length > 0);

  const mvp_plan = {
    milestones: milestones.length > 0 ? milestones : [{ week: 1, tasks: ["Implement MVP flow"] }],
  };

  const acceptance_tests = (wire.acceptance_tests ?? [])
    .map((item) => {
      if (typeof item === "string") return item;
      return asString(item.test, "");
    })
    .filter((x) => x.length > 0);
  if (acceptance_tests.length === 0) {
    acceptance_tests.push("Given valid input, when run, then result is stored and displayed.");
    fixes.push("acceptance_tests defaulted to one baseline test");
  }

  const open_questions = Array.isArray(wire.open_questions)
    ? wire.open_questions.filter((x): x is string => typeof x === "string")
    : [];

  const scores = {
    closure: asInt(wire.scores?.closure, 3),
    feasibility: asInt(wire.scores?.feasibility, 3),
    stack_fit: asInt(wire.scores?.stack_fit, 3),
    complexity_control: asInt(wire.scores?.complexity_control, 3),
    debuggability: asInt(wire.scores?.debuggability, 3),
    demo_value: asInt(wire.scores?.demo_value, 3),
  };

  const overall =
    wire.overall_recommendation === "go" || wire.overall_recommendation === "hold"
      ? wire.overall_recommendation
      : wire.overall_recommendation === "proceed"
        ? "go"
        : "hold";

  const citations: CanonicalSpec["citations"] = {
    app: [],
    core_loop: [],
    screens: {},
    commands: {},
    tables: {},
    acceptance_tests: {},
  };

  if (wire.citations && typeof wire.citations === "object" && !Array.isArray(wire.citations)) {
    const maybe = wire.citations as Record<string, unknown>;
    if (Array.isArray(maybe.items)) {
      for (const item of maybe.items) {
        if (!item || typeof item !== "object") continue;
        const key = (item as Record<string, unknown>).key;
        const evidence = (item as Record<string, unknown>).evidence_ids;
        if (typeof key !== "string" || !Array.isArray(evidence)) continue;
        const ids = evidence.filter((x): x is string => typeof x === "string");
        const parsed = parseCitationKey(key);
        if (!parsed) {
          warnings.push(`unknown citation key ignored: ${key}`);
          continue;
        }
        if (parsed.field === "app" || parsed.field === "core_loop") {
          citations[parsed.field] = dedupeSorted([...citations[parsed.field], ...ids]);
        } else if (parsed.name) {
          citations[parsed.field][parsed.name] = dedupeSorted([
            ...(citations[parsed.field][parsed.name] ?? []),
            ...ids,
          ]);
        }
      }
      fixes.push("citations converted from list form to map form");
    } else {
      citations.app = Array.isArray(maybe.app)
        ? dedupeSorted(maybe.app.filter((x): x is string => typeof x === "string"))
        : [];
      citations.core_loop = Array.isArray(maybe.core_loop)
        ? dedupeSorted(maybe.core_loop.filter((x): x is string => typeof x === "string"))
        : [];
      citations.screens =
        maybe.screens && typeof maybe.screens === "object" && !Array.isArray(maybe.screens)
          ? Object.fromEntries(
              Object.entries(maybe.screens).map(([k, v]) => [
                k,
                dedupeSorted(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []),
              ]),
            )
          : {};
      citations.commands =
        maybe.commands && typeof maybe.commands === "object" && !Array.isArray(maybe.commands)
          ? Object.fromEntries(
              Object.entries(maybe.commands).map(([k, v]) => [
                k,
                dedupeSorted(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []),
              ]),
            )
          : {};
      citations.tables =
        maybe.tables && typeof maybe.tables === "object" && !Array.isArray(maybe.tables)
          ? Object.fromEntries(
              Object.entries(maybe.tables).map(([k, v]) => [
                k,
                dedupeSorted(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []),
              ]),
            )
          : {};
      citations.acceptance_tests =
        maybe.acceptance_tests && typeof maybe.acceptance_tests === "object" && !Array.isArray(maybe.acceptance_tests)
          ? Object.fromEntries(
              Object.entries(maybe.acceptance_tests).map(([k, v]) => [
                k,
                dedupeSorted(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []),
              ]),
            )
          : {};
    }
  }

  for (const screen of screens) {
    if (!citations.screens[screen.id]) {
      citations.screens[screen.id] = [];
      fixes.push(`citations.screens key added for ${screen.id}`);
    }
  }
  for (const command of rust_commands) {
    if (!citations.commands[command.name]) {
      citations.commands[command.name] = [];
      fixes.push(`citations.commands key added for ${command.name}`);
    }
  }
  for (const table of tables) {
    if (!citations.tables[table.name]) {
      citations.tables[table.name] = [];
      fixes.push(`citations.tables key added for ${table.name}`);
    }
  }
  for (let i = 0; i < acceptance_tests.length; i += 1) {
    const key = String(i);
    if (!citations.acceptance_tests[key]) {
      citations.acceptance_tests[key] = [];
      fixes.push(`citations.acceptance_tests key added for ${key}`);
    }
  }

  const canonical: CanonicalSpec = {
    schema_version: 1,
    meta: {
      run_id,
      generated_at,
      source_repo,
      topics,
    },
    app,
    core_loop,
    screens,
    rust_commands,
    data_model: { tables },
    tauri_capabilities,
    mvp_plan,
    acceptance_tests,
    open_questions,
    scores,
    overall_recommendation: overall,
    citations: {
      app: dedupeSorted(citations.app),
      core_loop: dedupeSorted(citations.core_loop),
      screens: Object.fromEntries(
        Object.entries(citations.screens).map(([k, v]) => [k, dedupeSorted(v)]),
      ),
      commands: Object.fromEntries(
        Object.entries(citations.commands).map(([k, v]) => [k, dedupeSorted(v)]),
      ),
      tables: Object.fromEntries(
        Object.entries(citations.tables).map(([k, v]) => [k, dedupeSorted(v)]),
      ),
      acceptance_tests: Object.fromEntries(
        Object.entries(citations.acceptance_tests).map(([k, v]) => [k, dedupeSorted(v)]),
      ),
    },
  };

  return {
    canonical,
    normalize_report: { fixes, warnings },
  };
}
