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

export function normalizeWireToCanonical(
  params: NormalizeParams,
): { canonical: CanonicalSpec; normalize_report: { fixes: string[]; warnings: string[] } } {
  const { wire } = params;
  const fixes: string[] = [];
  const warnings: string[] = [];

  const oneLinerFromWire =
    (wire.app && typeof (wire.app as any).one_liner === "string" ? (wire.app as any).one_liner : undefined) ??
    (wire.app?.one_sentence ?? undefined);

  const app = {
    name: asString(wire.app?.name, "Untitled App"),
    one_liner: asString(oneLinerFromWire, "A desktop app generated from repository evidence."),
  };

  const screens = (wire.screens ?? [])
    .map((item, idx) => {
      if (typeof item === "string") {
        return {
          name: item,
          purpose: item,
          primary_actions: ["Open", "Run"],
        };
      }
      return {
        name: asString(item.name, `Screen ${idx + 1}`),
        purpose: asString(item.purpose, "Main workflow screen"),
        primary_actions: Array.isArray(item.primary_actions)
          ? item.primary_actions.filter((x): x is string => typeof x === "string")
          : ["Open", "Run"],
      };
    })
    .filter((item) => item.name);

  if (screens.length === 0) {
    screens.push({
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
          columns: [{ name: "id", type: "TEXT" }],
        };
      }
      const rawCols: unknown[] = (item as any).columns ?? (item as any).fields ?? [];
      const columns = rawCols
        .map((f: unknown) => ({
          name: asString((f as any).name, "field"),
          type: asString((f as any).type, "TEXT"),
        }))
        .filter((f: { name: string; type: string }) => f.name && f.type);
      return {
        name: asString((item as any).name, `table_${idx + 1}`),
        columns: columns.length > 0 ? columns : [{ name: "id", type: "TEXT" }],
      };
    })
    .filter((t) => t.name);

  if (tables.length === 0) {
    tables.push({
      name: "records",
      columns: [
        { name: "id", type: "TEXT" },
        { name: "created_at", type: "TEXT" },
      ],
    });
    fixes.push("data_model.tables defaulted to records");
  }

  const milestoneSource =
    !Array.isArray(wire.mvp_plan) && Array.isArray(wire.mvp_plan?.milestones)
      ? wire.mvp_plan.milestones
      : [];
  const milestones = milestoneSource
    .map((m, idx) => ({
      week: typeof m.week === "number" ? Math.max(1, Math.trunc(m.week)) : Number(m.week) || idx + 1,
      tasks: Array.isArray(m.tasks) ? m.tasks.filter((x): x is string => typeof x === "string") : [],
    }))
    .filter((m) => m.tasks.length > 0);

  const mvp_plan: string[] = (() => {
    if (Array.isArray(wire.mvp_plan)) {
      const xs = wire.mvp_plan.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      return xs.length > 0 ? xs : ["week 1: Implement MVP flow"];
    }
    const ms = milestones.length > 0 ? milestones : [{ week: 1, tasks: ["Implement MVP flow"] }];
    const out: string[] = [];
    for (const m of ms) {
      const week = typeof m.week === "number" ? m.week : 1;
      for (const t of m.tasks) {
        const task = typeof t === "string" ? t.trim() : "";
        if (!task) continue;
        out.push(`week ${week}: ${task}`);
      }
    }
    return out.length > 0 ? out : ["week 1: Implement MVP flow"];
  })();

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

  const canonical: CanonicalSpec = {
    schema_version: 3,
    app,
    screens,
    rust_commands,
    data_model: {
      tables: tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
    },
    mvp_plan,
    acceptance_tests,
  };

  return {
    canonical,
    normalize_report: { fixes, warnings },
  };
}
