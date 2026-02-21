import type { CanonicalSpec } from "./canonicalSchemas";
import type { QualityGateConfig } from "./types";

export function qualityGate(canonical: CanonicalSpec, config: QualityGateConfig): {
  ok: boolean;
  empty_fields: string[];
  coverage: { total: number; cited: number; ratio: number };
  notes: string[];
} {
  void canonical;
  void config;
  const emptyFields: string[] = [];
  const total = 0;
  const cited = 0;
  const ratio = total > 0 ? Number((cited / total).toFixed(4)) : 1;
  const notes: string[] = [];

  return {
    ok: true,
    empty_fields: emptyFields,
    coverage: { total, cited, ratio },
    notes,
  };
}
