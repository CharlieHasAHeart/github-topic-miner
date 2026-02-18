import type { CanonicalSpec } from "./canonicalSchemas";

function stableUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function ensureCitationCoverage(canonical: CanonicalSpec): {
  canonical: CanonicalSpec;
  addedKeys: string[];
  warnings: string[];
} {
  const addedKeys: string[] = [];
  const warnings: string[] = [];
  const out: CanonicalSpec = structuredClone(canonical);

  out.citations.app = stableUnique(out.citations.app ?? []);
  out.citations.core_loop = stableUnique(out.citations.core_loop ?? []);
  out.citations.screens = out.citations.screens ?? {};
  out.citations.commands = out.citations.commands ?? {};
  out.citations.tables = out.citations.tables ?? {};
  out.citations.acceptance_tests = out.citations.acceptance_tests ?? {};

  for (const screen of out.screens) {
    if (!(screen.id in out.citations.screens)) {
      out.citations.screens[screen.id] = [];
      addedKeys.push(`screen:${screen.id}`);
    } else {
      out.citations.screens[screen.id] = stableUnique(out.citations.screens[screen.id] ?? []);
    }
  }
  for (const command of out.rust_commands) {
    if (!(command.name in out.citations.commands)) {
      out.citations.commands[command.name] = [];
      addedKeys.push(`command:${command.name}`);
    } else {
      out.citations.commands[command.name] = stableUnique(out.citations.commands[command.name] ?? []);
    }
  }
  for (const table of out.data_model.tables) {
    if (!(table.name in out.citations.tables)) {
      out.citations.tables[table.name] = [];
      addedKeys.push(`table:${table.name}`);
    } else {
      out.citations.tables[table.name] = stableUnique(out.citations.tables[table.name] ?? []);
    }
  }
  for (let i = 0; i < out.acceptance_tests.length; i += 1) {
    const key = String(i);
    if (!(key in out.citations.acceptance_tests)) {
      out.citations.acceptance_tests[key] = [];
      addedKeys.push(`acceptance_test:${key}`);
    } else {
      out.citations.acceptance_tests[key] = stableUnique(out.citations.acceptance_tests[key] ?? []);
    }
  }

  if (addedKeys.length === 0) warnings.push("citation keys already complete");
  return { canonical: out, addedKeys, warnings };
}
