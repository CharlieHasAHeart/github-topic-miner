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

const IO_TYPE_REGEX = /^(string|boolean|int|float|timestamp|json)\??$/;
const PLACEHOLDER_KEYS = new Set(["placeholder", "todo", "tbd", "example", "dummy", "mock"]);

function isPlaceholderKey(key: string): boolean {
  return PLACEHOLDER_KEYS.has(key.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function maybeIoTypeString(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (IO_TYPE_REGEX.test(normalized)) return normalized;
  switch (normalized) {
    case "integer":
      return "int";
    case "real":
    case "number":
      return "float";
    case "bool":
      return "boolean";
    case "datetime":
    case "date":
    case "time":
      return "timestamp";
    case "object":
    case "array":
    case "map":
    case "dict":
      return "json";
    default:
      return null;
  }
}

function scalarToIoType(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = maybeIoTypeString(value);
    return normalized ?? "string";
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return "json";
  if (isPlainObject(value)) return "json";
  return null;
}

function unwrapRequest(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const hasRequest = Object.prototype.hasOwnProperty.call(input, "request");
  const requestValue = input.request;
  if (!hasRequest || !isPlainObject(requestValue)) return input;
  const withoutRequest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "request"));
  return { ...(requestValue as Record<string, unknown>), ...withoutRequest };
}

function toIoFieldDict(input: unknown): Record<string, string> {
  const unwrapped = unwrapRequest(input);
  if (!isPlainObject(unwrapped)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(unwrapped)) {
    if (!key.trim()) continue;
    if (isPlaceholderKey(key)) continue;
    const inferred = scalarToIoType(value);
    if (!inferred) continue;
    out[key] = inferred;
  }
  return out;
}

function isInvalidIoFieldDict(dict: Record<string, string>): boolean {
  const keys = Object.keys(dict);
  if (keys.length === 0) return true;
  if (keys.some((k) => isPlaceholderKey(k))) return true;
  if (Object.values(dict).some((v) => !IO_TYPE_REGEX.test(v))) return true;
  return false;
}

function ioTypeFromColumnType(type: string): string {
  switch (normalizeColumnType(type)) {
    case "INTEGER":
      return "int";
    case "REAL":
      return "float";
    case "BOOLEAN":
      return "boolean";
    case "JSON":
    case "BLOB":
      return "json";
    case "DATETIME":
      return "timestamp";
    default:
      return "string";
  }
}

function buildPayloadFromTable(
  table: { name: string; columns: Array<{ name: string; type: string }> } | undefined,
): Record<string, string> {
  if (!table || table.columns.length === 0) {
    return {};
  }
  const entries = table.columns
    .filter((c) => c.name.toLowerCase() !== "id")
    .slice(0, 6)
    .map((c) => [c.name, ioTypeFromColumnType(c.type)] as const);
  return Object.fromEntries(entries);
}

function buildCommandTemplate(
  commandName: string,
): { input: Record<string, string>; output: Record<string, string> } {
  const lower = commandName.toLowerCase();
  if (lower.startsWith("lint_")) {
    return {
      input: { file_path: "string", tool_type: "string?" },
      output: { ok: "boolean", message: "string?", diagnostics: "json?" },
    };
  }
  if (lower.startsWith("apply_") || lower.startsWith("fix_")) {
    return {
      input: { file_path: "string", fix_ids: "json?" },
      output: { ok: "boolean", message: "string?", changed: "boolean?", diff: "string?" },
    };
  }
  if (lower.startsWith("connect_")) {
    return {
      input: { endpoint: "string", timeout_ms: "int?" },
      output: { connected: "boolean", endpoint: "string", connected_at: "timestamp" },
    };
  }
  if (lower.startsWith("list_")) {
    return {
      input: { query: "string?", limit: "int?", offset: "int?" },
      output: { items: "json", total: "int?" },
    };
  }
  return {
    input: { payload: "json" },
    output: { ok: "boolean", result: "json?" },
  };
}

function mergeMissing(base: Record<string, string>, patch: Record<string, string>): Record<string, string> {
  return { ...patch, ...base };
}

function validateCommandIO(
  command: { name: string; purpose: string; input: unknown; output: unknown },
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>,
  fixes: string[],
): { input: Record<string, string>; output: Record<string, string> } {
  const name = command.name;
  const purpose = command.purpose;
  const text = `${name} ${purpose}`;
  const primaryTable = tables[0];
  const inferredFromDataModel = buildPayloadFromTable(primaryTable);
  const template = buildCommandTemplate(name);

  let normalizedInput = toIoFieldDict(command.input);
  let normalizedOutput = toIoFieldDict(command.output);

  if (isInvalidIoFieldDict(normalizedInput)) {
    normalizedInput = mergeMissing(normalizedInput, template.input);
    if (Object.keys(inferredFromDataModel).length > 0) {
      normalizedInput = mergeMissing(normalizedInput, inferredFromDataModel);
    }
    fixes.push(`rule:command_io_enriched:input:${name}`);
  }
  if (isInvalidIoFieldDict(normalizedOutput)) {
    normalizedOutput = mergeMissing(normalizedOutput, template.output);
    if (/(create|insert|add|save|apply|fix|update|delete|remove)/.test(text.toLowerCase())) {
      normalizedOutput = mergeMissing(normalizedOutput, { ok: "boolean" });
    }
    fixes.push(`rule:command_io_enriched:output:${name}`);
  }
  if (isInvalidIoFieldDict(normalizedInput)) {
    normalizedInput = { payload: "json" };
    fixes.push(`rule:command_io_fallback:input:${name}`);
  }
  if (isInvalidIoFieldDict(normalizedOutput)) {
    normalizedOutput = { ok: "boolean", result: "json?" };
    fixes.push(`rule:command_io_fallback:output:${name}`);
  }

  for (const side of [normalizedInput, normalizedOutput]) {
    if ("request" in side) {
      delete side.request;
      fixes.push(`rule:command_io_strip_request:${name}`);
    }
    for (const key of Object.keys(side)) {
      if (isPlaceholderKey(key)) {
        delete side[key];
        fixes.push(`rule:command_io_drop_placeholder_key:${name}.${key}`);
      }
    }
  }
  if (Object.keys(normalizedInput).length === 0) normalizedInput = { payload: "json" };
  if (Object.keys(normalizedOutput).length === 0) normalizedOutput = { ok: "boolean", result: "json?" };

  return {
    input: Object.fromEntries(Object.entries(normalizedInput).sort(([a], [b]) => a.localeCompare(b))),
    output: Object.fromEntries(Object.entries(normalizedOutput).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function normalizeColumnType(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return "TEXT";
  if (["int", "integer", "i32", "i64", "u32", "u64", "number_int"].includes(text)) return "INTEGER";
  if (["float", "double", "real", "decimal", "number_float", "number", "f32", "f64"].includes(text)) return "REAL";
  if (["bool", "boolean"].includes(text)) return "BOOLEAN";
  if (["blob", "binary", "bytes"].includes(text)) return "BLOB";
  if (
    [
      "json",
      "jsonb",
      "object",
      "map",
      "dict",
      "array",
      "list",
      "set",
      "any",
      "function",
      "vector",
      "typescript type",
      "optional string",
      "array<string>",
      "string?",
      "enum",
      "foreign_key",
    ].includes(text)
  ) {
    return "JSON";
  }
  if (["datetime", "timestamp", "date", "time"].includes(text)) return "DATETIME";
  if (["string", "str", "text", "varchar", "char"].includes(text)) return "TEXT";
  if (text.startsWith("array<")) return "JSON";
  if (text.endsWith("?")) return "TEXT";
  return "TEXT";
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

  const rust_commands: Array<{
    name: string;
    purpose: string;
    async: boolean;
    input: unknown;
    output: unknown;
  }> = (wire.rust_commands ?? [])
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
        input: item.input,
        output: item.output,
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
  {
    const used = new Set<string>();
    for (const c of rust_commands) {
      const prev = c.name;
      c.name = uniqueName(c.name, used);
      const validated = validateCommandIO(c, tables, fixes);
      c.input = validated.input;
      c.output = validated.output;
      if (prev !== c.name) fixes.push(`rule:name_unique:rust_commands:${prev}->${c.name}`);
    }
    rust_commands.sort((a, b) => a.name.localeCompare(b.name));
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

  const canonicalCommands = rust_commands.map((c) => ({
    ...c,
    input: c.input as Record<string, string>,
    output: c.output as Record<string, string>,
  }));

  const canonical: CanonicalSpec = {
    schema_version: 3,
    app,
    screens,
    rust_commands: canonicalCommands,
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
