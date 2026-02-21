import type { CanonicalSpec } from "./canonicalSchemas";

export function computeMissingCitationKeys(_spec: CanonicalSpec): string[] {
  return [];
}

export function applyCitationsPatch(spec: CanonicalSpec): CanonicalSpec {
  return spec;
}
