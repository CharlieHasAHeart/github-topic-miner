import { CanonicalSpecSchema, type CanonicalSpec } from "./canonicalSchemas";
import { normalizeWireToCanonical } from "./normalize";
import type { BridgeReport, QualityGateConfig } from "./types";
import { WireSpecSchema } from "./wireSchemas";

interface RunBridgeParams {
  repo: string;
  run_id: string;
  generated_at: string;
  source_repo: { full_name: string; url: string };
  topics: string[];
  wireRaw: unknown;
  allowedEvidenceIds: string[];
  evidenceLines: string[];
  provider?: "openai" | "anthropic" | "gemini" | "qwen" | "deepseek";
  model: string;
  temperature: number;
  maxRepairAttempts?: number;
  qualityConfig?: QualityGateConfig;
  iter?: number;
  onAudit?: (audit: any) => void;
  onEvent?: (event: string, data?: Record<string, unknown>) => void;
}

function parseRaw(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    const firstBrace = value.indexOf("{");
    const firstBracket = value.indexOf("[");
    const starts = [firstBrace, firstBracket].filter((x) => x >= 0);
    if (starts.length === 0) throw new Error("No JSON found in raw text");
    return JSON.parse(value.slice(Math.min(...starts)));
  }
}

export async function runBridge(params: RunBridgeParams): Promise<{
  ok: boolean;
  canonical?: CanonicalSpec;
  report: BridgeReport;
}> {
  const _qualityConfig: QualityGateConfig = {
    requireNonEmpty: true,
    minCoverageRatio: 1,
    ...(params.qualityConfig ?? {}),
  };
  const _maxRepairAttempts = Math.max(0, params.maxRepairAttempts ?? 2);

  const report: BridgeReport = {
    repo: params.repo,
    run_id: params.run_id,
    generated_at: params.generated_at,
    stages: [],
    final: { ok: false, attempts_used: 0 },
  };

  let parsedRaw: unknown;
  try {
    parsedRaw = parseRaw(params.wireRaw);
    report.stages.push({ name: "parse", ok: true, stats: { attempt: 0 } });
  } catch (error) {
    report.stages.push({
      name: "parse",
      ok: false,
      error_code: "PARSE_FAILED",
      error_detail: error instanceof Error ? error.message : String(error),
      stats: { attempt: 0 },
    });
    report.final = { ok: false, reason: "parse failed", attempts_used: 0 };
    return { ok: false, report };
  }

  let wire;
  try {
    wire = WireSpecSchema.parse(parsedRaw);
    report.stages.push({ name: "wire_validate", ok: true, stats: { attempt: 0 } });
  } catch (error) {
    report.stages.push({
      name: "wire_validate",
      ok: false,
      error_code: "WIRE_VALIDATE_FAILED",
      error_detail: error instanceof Error ? error.message : String(error),
      stats: { attempt: 0 },
    });
    report.final = { ok: false, reason: "wire validation failed", attempts_used: 0 };
    return { ok: false, report };
  }

  const normalized = normalizeWireToCanonical({
    wire,
    run_id: params.run_id,
    generated_at: params.generated_at,
    source_repo: params.source_repo,
    topics: params.topics,
  });
  report.normalize_report = normalized.normalize_report;
  report.stages.push({
    name: "normalize",
    ok: true,
    stats: { fixes: normalized.normalize_report.fixes.length, warnings: normalized.normalize_report.warnings.length },
  });

  let canonical: CanonicalSpec;
  try {
    canonical = CanonicalSpecSchema.parse(normalized.canonical);
  } catch (error) {
    report.stages.push({
      name: "canonical_validate",
      ok: false,
      error_code: "CANONICAL_VALIDATE_FAILED",
      error_detail: error instanceof Error ? error.message : String(error),
      stats: { attempt: 0 },
    });
    report.final = { ok: false, reason: "canonical validation failed", attempts_used: 0 };
    return { ok: false, report };
  }

  report.final = { ok: true, attempts_used: 0 };
  return { ok: true, canonical, report };
}
