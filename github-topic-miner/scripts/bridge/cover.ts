import type { CanonicalSpec } from "./canonicalSchemas";

export function ensureCitationCoverage(_spec: CanonicalSpec) {
  // v3 minimal schema: no citations stage
  return { ok: true as const, missing: [] as string[] };
}
