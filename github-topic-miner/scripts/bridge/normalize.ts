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

function ensureNonEmptyPayload(value: unknown): unknown {
  if (value === null || value === undefined) return { placeholder: true };
  if (typeof value === "string") return value.trim().length > 0 ? value : "placeholder";
  if (Array.isArray(value)) return value.length > 0 ? value : ["placeholder"];
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0 ? value : { placeholder: true };
  }
  return value;
}

function normalizeColumnType(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return "TEXT";
  if (["int", "integer", "i32", "i64", "u32", "u64", "number_int"].includes(text)) return "INTEGER";
  if (["float", "double", "real", "decimal", "number_float"].includes(text)) return "REAL";
  if (["bool", "boolean"].includes(text)) return "BOOLEAN";
  if (["blob", "binary", "bytes"].includes(text)) return "BLOB";
  if (["json", "jsonb", "object", "map", "dict"].includes(text)) return "JSON";
  if (["datetime", "timestamp", "date", "time"].includes(text)) return "DATETIME";
  if (["string", "str", "text", "varchar", "char"].includes(text)) return "TEXT";
  return text.toUpperCase();
}

function uniqueName(baseRaw: string, used: Set<string>): string {
  const base = baseRaw.trim() || "item";
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  used.add(name);
  return name;
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
  {
    const used = new Set<string>();
    for (const s of screens) {
      const prev = s.name;
      s.name = uniqueName(s.name, used);
      s.primary_actions = [...new Set(s.primary_actions)].sort((a, b) => a.localeCompare(b));
      if (prev !== s.name) fixes.push(`rule:name_unique:screens:${prev}->${s.name}`);
    }
    screens.sort((a, b) => a.name.localeCompare(b.name));
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
        input: ensureNonEmptyPayload(item.input),
        output: ensureNonEmptyPayload(item.output),
      };
    })
    .filter((item) => item.name);

  if (rust_commands.length === 0) {
    rust_commands.push({
      name: "run_main_flow",
      purpose: "Execute core flow",
      async: true,
      input: { placeholder: true },
      output: { placeholder: true },
    });
    fixes.push("rust_commands defaulted to run_main_flow");
  }
  {
    const used = new Set<string>();
    for (const c of rust_commands) {
      const prev = c.name;
      c.name = uniqueName(c.name, used);
      c.input = ensureNonEmptyPayload(c.input);
      c.output = ensureNonEmptyPayload(c.output);
      if (prev !== c.name) fixes.push(`rule:name_unique:rust_commands:${prev}->${c.name}`);
    }
    rust_commands.sort((a, b) => a.name.localeCompare(b.name));
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
          type: normalizeColumnType((f as any).type),
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
  {
    const usedTableNames = new Set<string>();
    for (const t of tables) {
      const prev = t.name;
      t.name = uniqueName(t.name, usedTableNames);
      if (prev !== t.name) fixes.push(`rule:name_unique:tables:${prev}->${t.name}`);

      const usedColumnNames = new Set<string>();
      for (const col of t.columns) {
        const prevCol = col.name;
        col.name = uniqueName(col.name, usedColumnNames);
        col.type = normalizeColumnType(col.type);
        if (prevCol !== col.name) fixes.push(`rule:name_unique:columns:${t.name}.${prevCol}->${col.name}`);
      }
      t.columns.sort((a, b) => a.name.localeCompare(b.name));
    }
    tables.sort((a, b) => a.name.localeCompare(b.name));
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
  mvp_plan.sort((a, b) => a.localeCompare(b));

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
  acceptance_tests.sort((a, b) => a.localeCompare(b));

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
