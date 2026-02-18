export type BridgeStageName =
  | "parse"
  | "wire_validate"
  | "normalize"
  | "cover"
  | "canonical_validate"
  | "evidence_gate"
  | "quality_gate"
  | "repair";

export interface BridgeStageResult {
  name: BridgeStageName;
  ok: boolean;
  error_code?: string;
  error_detail?: string;
  stats?: Record<string, unknown>;
}

export interface BridgeReport {
  repo: string;
  run_id: string;
  generated_at: string;
  stages: BridgeStageResult[];
  final: {
    ok: boolean;
    reason?: string;
    unknown_ids_count?: number;
    empty_fields_count?: number;
    coverage_ratio?: number;
    attempts_used?: number;
  };
  normalize_report?: {
    fixes: string[];
    warnings: string[];
  };
}

export interface QualityGateConfig {
  requireNonEmpty: boolean;
  minCoverageRatio: number;
}
