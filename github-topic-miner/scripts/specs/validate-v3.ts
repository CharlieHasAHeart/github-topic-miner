import fs from "node:fs";
import path from "node:path";
import { CanonicalSpecSchema, type CanonicalSpec } from "../bridge/canonicalSchemas";

const ALLOWED_TOP_LEVEL = new Set([
  "schema_version",
  "app",
  "screens",
  "rust_commands",
  "data_model",
  "mvp_plan",
  "acceptance_tests",
]);

const NORMALIZED_TYPES = new Set(["INTEGER", "REAL", "BOOLEAN", "BLOB", "JSON", "DATETIME", "TEXT"]);
const PLACEHOLDER_KEYS = new Set(["placeholder", "todo", "tbd", "example", "dummy", "mock"]);

type Violation = { file: string; rule: string; detail: string };

function isDateDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function collectSpecFiles(specsRoot: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(specsRoot)) return out;
  for (const entry of fs.readdirSync(specsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isDateDir(entry.name)) continue;
    const dir = path.join(specsRoot, entry.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      out.push(path.join(dir, file.name));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function hasPlaceholderKeyDeep(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((x) => hasPlaceholderKeyDeep(x));
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (PLACEHOLDER_KEYS.has(k.toLowerCase())) return true;
    if (hasPlaceholderKeyDeep(v)) return true;
  }
  return false;
}

function collectViolations(file: string, raw: unknown, spec: CanonicalSpec): Violation[] {
  const violations: Violation[] = [];

  const top = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw as Record<string, unknown>) : [];
  for (const key of top) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      violations.push({ file, rule: "field_set_minimal", detail: `extra top-level key: ${key}` });
    }
  }
  for (const key of ALLOWED_TOP_LEVEL) {
    if (!top.includes(key)) {
      violations.push({ file, rule: "field_set_minimal", detail: `missing top-level key: ${key}` });
    }
  }

  const screenNames = new Set<string>();
  for (const s of spec.screens) {
    if (screenNames.has(s.name)) {
      violations.push({ file, rule: "name_unique", detail: `duplicate screen name: ${s.name}` });
    }
    screenNames.add(s.name);
  }

  const commandNames = new Set<string>();
  for (const c of spec.rust_commands) {
    if (commandNames.has(c.name)) {
      violations.push({ file, rule: "name_unique", detail: `duplicate rust command name: ${c.name}` });
    }
    commandNames.add(c.name);

    if (!isNonEmptyObject(c.input)) {
      violations.push({ file, rule: "command_io_non_empty", detail: `${c.name}.input is empty or non-object` });
    }
    if (!isNonEmptyObject(c.output)) {
      violations.push({ file, rule: "command_io_non_empty", detail: `${c.name}.output is empty or non-object` });
    }
    if (hasPlaceholderKeyDeep(c.input)) {
      violations.push({ file, rule: "command_io_non_empty", detail: `${c.name}.input contains placeholder key` });
    }
    if (hasPlaceholderKeyDeep(c.output)) {
      violations.push({ file, rule: "command_io_non_empty", detail: `${c.name}.output contains placeholder key` });
    }
  }

  const tableNames = new Set<string>();
  for (const t of spec.data_model.tables) {
    if (tableNames.has(t.name)) {
      violations.push({ file, rule: "name_unique", detail: `duplicate table name: ${t.name}` });
    }
    tableNames.add(t.name);

    const columnNames = new Set<string>();
    for (const c of t.columns) {
      if (columnNames.has(c.name)) {
        violations.push({
          file,
          rule: "name_unique",
          detail: `duplicate column name in table ${t.name}: ${c.name}`,
        });
      }
      columnNames.add(c.name);
      if (!NORMALIZED_TYPES.has(c.type)) {
        violations.push({
          file,
          rule: "column_type_normalized",
          detail: `${t.name}.${c.name} has non-normalized type: ${c.type}`,
        });
      }
    }
  }

  return violations;
}

function run() {
  const root = process.cwd();
  const specsRoot = path.join(root, "specs");
  const files = collectSpecFiles(specsRoot);
  const all: Violation[] = [];

  for (const file of files) {
    const rawText = fs.readFileSync(file, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      all.push({
        file,
        rule: "json_parse",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const parsed = CanonicalSpecSchema.safeParse(raw);
    if (!parsed.success) {
      all.push({
        file,
        rule: "canonical_schema_v3",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | "),
      });
      continue;
    }
    all.push(...collectViolations(file, raw, parsed.data));
  }

  if (all.length === 0) {
    console.log(`specs validate complete: files=${files.length}, violations=0`);
    return;
  }

  console.error(`specs validate failed: files=${files.length}, violations=${all.length}`);
  const grouped = new Map<string, Violation[]>();
  for (const v of all) grouped.set(v.file, [...(grouped.get(v.file) ?? []), v]);
  for (const [file, vs] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`\n${path.relative(root, file)}`);
    for (const v of vs) {
      console.error(`  - ${v.rule}: ${v.detail}`);
    }
  }
  process.exitCode = 1;
}

run();
