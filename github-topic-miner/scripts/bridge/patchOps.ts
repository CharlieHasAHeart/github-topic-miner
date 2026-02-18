import type { CanonicalSpec } from "./canonicalSchemas";
import type { CitationsPatch } from "./patchSchemas";

function stableUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function computeMissingCitationKeys(
  canonical: CanonicalSpec,
  requireNonEmpty = true,
): string[] {
  const missing: string[] = [];
  const check = (key: string, ids: string[]) => {
    if (requireNonEmpty && ids.length === 0) missing.push(key);
  };

  if (canonical.citations.app.length === 0) missing.push("app");
  if (canonical.citations.core_loop.length === 0) missing.push("core_loop");
  for (const screen of canonical.screens) {
    check(`screen:${screen.id}`, canonical.citations.screens[screen.id] ?? []);
  }
  for (const command of canonical.rust_commands) {
    check(`command:${command.name}`, canonical.citations.commands[command.name] ?? []);
  }
  for (const table of canonical.data_model.tables) {
    check(`table:${table.name}`, canonical.citations.tables[table.name] ?? []);
  }
  for (let i = 0; i < canonical.acceptance_tests.length; i += 1) {
    check(`acceptance_test:${i}`, canonical.citations.acceptance_tests[String(i)] ?? []);
  }
  return missing;
}

export function applyCitationsPatch(canonical: CanonicalSpec, patch: CitationsPatch): CanonicalSpec {
  const out: CanonicalSpec = structuredClone(canonical);

  if (patch.app) out.citations.app = stableUnique(patch.app);
  if (patch.core_loop) out.citations.core_loop = stableUnique(patch.core_loop);
  if (patch.screens) {
    for (const [k, v] of Object.entries(patch.screens)) out.citations.screens[k] = stableUnique(v);
  }
  if (patch.commands) {
    for (const [k, v] of Object.entries(patch.commands)) out.citations.commands[k] = stableUnique(v);
  }
  if (patch.tables) {
    for (const [k, v] of Object.entries(patch.tables)) out.citations.tables[k] = stableUnique(v);
  }
  if (patch.acceptance_tests) {
    for (const [k, v] of Object.entries(patch.acceptance_tests)) {
      out.citations.acceptance_tests[k] = stableUnique(v);
    }
  }

  return out;
}
