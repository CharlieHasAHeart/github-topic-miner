import type { CanonicalSpec } from "./canonicalSchemas";

export function collectCitedEvidenceIds(canonical: CanonicalSpec): string[] {
  const ids = new Set<string>();
  const add = (values: string[]) => {
    for (const value of values) {
      ids.add(value);
    }
  };

  add(canonical.citations.app);
  add(canonical.citations.core_loop);
  for (const values of Object.values(canonical.citations.screens)) add(values);
  for (const values of Object.values(canonical.citations.commands)) add(values);
  for (const values of Object.values(canonical.citations.tables)) add(values);
  for (const values of Object.values(canonical.citations.acceptance_tests)) add(values);

  return [...ids];
}

export function evidenceGate(
  canonical: CanonicalSpec,
  allowedEvidenceIds: string[],
): { ok: boolean; unknown_ids: string[]; notes: string[] } {
  const cited = collectCitedEvidenceIds(canonical);
  const allowed = new Set(allowedEvidenceIds);
  const unknown = cited.filter((id) => !allowed.has(id));
  return {
    ok: unknown.length === 0,
    unknown_ids: unknown,
    notes: unknown.length ? ["unknown evidence ids found in citations"] : [],
  };
}
