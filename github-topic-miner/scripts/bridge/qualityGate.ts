import type { CanonicalSpec } from "./canonicalSchemas";
import type { QualityGateConfig } from "./types";

export function qualityGate(canonical: CanonicalSpec, config: QualityGateConfig): {
  ok: boolean;
  empty_fields: string[];
  coverage: { total: number; cited: number; ratio: number };
  notes: string[];
} {
  const emptyFields: string[] = [];
  let total = 0;
  let cited = 0;

  const check = (name: string, ids: string[]) => {
    total += 1;
    if (ids.length > 0) {
      cited += 1;
    } else {
      emptyFields.push(name);
    }
  };

  check("app", canonical.citations.app);
  check("core_loop", canonical.citations.core_loop);

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

  const ratio = total > 0 ? Number((cited / total).toFixed(4)) : 1;
  const notes: string[] = [];
  let ok = true;

  if (config.requireNonEmpty && emptyFields.length > 0) {
    ok = false;
    notes.push("requireNonEmpty=true and empty citation fields found");
  }

  if (ratio < config.minCoverageRatio) {
    ok = false;
    notes.push(`coverage ratio ${ratio} below threshold ${config.minCoverageRatio}`);
  }

  return {
    ok,
    empty_fields: emptyFields,
    coverage: { total, cited, ratio },
    notes,
  };
}
