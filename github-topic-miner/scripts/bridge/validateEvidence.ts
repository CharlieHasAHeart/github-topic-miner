import type { CanonicalSpec } from "./canonicalSchemas";

export function collectCitedEvidenceIds(canonical: CanonicalSpec): string[] {
  void canonical;
  return [];
}

export function evidenceGate(
  canonical: CanonicalSpec,
  allowedEvidenceIds: string[],
): { ok: boolean; unknown_ids: string[]; notes: string[] } {
  void canonical;
  void allowedEvidenceIds;
  return {
    ok: true,
    unknown_ids: [],
    notes: [],
  };
}
