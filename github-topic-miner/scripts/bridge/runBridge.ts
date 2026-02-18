import { CanonicalSpecSchema, type CanonicalSpec } from "./canonicalSchemas";
import { ensureCitationCoverage } from "./cover";
import { normalizeWireToCanonical } from "./normalize";
import { applyCitationsPatch, computeMissingCitationKeys } from "./patchOps";
import { repairCitationsWithPatch } from "./repair";
import { qualityGate } from "./qualityGate";
import type { BridgeReport, QualityGateConfig } from "./types";
import { evidenceGate } from "./validateEvidence";
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

function unknownIdsFromPatch(patch: unknown, allowedEvidenceIds: string[]): string[] {
  const allowed = new Set(allowedEvidenceIds);
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) if (typeof item === "string") ids.push(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    }
  };
  walk(patch);
  return [...new Set(ids.filter((id) => !allowed.has(id)))];
}

export async function runBridge(params: RunBridgeParams): Promise<{
  ok: boolean;
  canonical?: CanonicalSpec;
  report: BridgeReport;
}> {
  const qualityConfig: QualityGateConfig = {
    requireNonEmpty: true,
    minCoverageRatio: 1,
    ...(params.qualityConfig ?? {}),
  };
  const maxRepairAttempts = Math.max(0, params.maxRepairAttempts ?? 2);

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

  const covered = ensureCitationCoverage(canonical);
  canonical = covered.canonical;
  report.stages.push({
    name: "cover",
    ok: true,
    stats: {
      added_keys_count: covered.addedKeys.length,
      added_keys_sample: covered.addedKeys.slice(0, 10),
    },
  });
  params.onEvent?.("BRIDGE_COVER_ADDED_KEYS", {
    repo: params.repo,
    iter: params.iter,
    added_keys_count: covered.addedKeys.length,
    sample: covered.addedKeys.slice(0, 10),
  });

  try {
    canonical = CanonicalSpecSchema.parse(canonical);
    report.stages.push({ name: "canonical_validate", ok: true, stats: { attempt: 0 } });
  } catch (error) {
    report.stages.push({
      name: "canonical_validate",
      ok: false,
      error_code: "CANONICAL_VALIDATE_FAILED",
      error_detail: error instanceof Error ? error.message : String(error),
      stats: { attempt: 0 },
    });
    report.final = { ok: false, reason: "canonical validation failed after cover", attempts_used: 0 };
    return { ok: false, report };
  }

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    report.final.attempts_used = attempt;

    const evidence = evidenceGate(canonical, params.allowedEvidenceIds);
    report.stages.push({
      name: "evidence_gate",
      ok: evidence.ok,
      stats: { unknown_ids_count: evidence.unknown_ids.length, attempt },
      ...(evidence.ok
        ? {}
        : {
            error_code: "UNKNOWN_EVIDENCE_IDS",
            error_detail: evidence.unknown_ids.join(", "),
          }),
    });

    const quality = qualityGate(canonical, qualityConfig);
    report.stages.push({
      name: "quality_gate",
      ok: quality.ok,
      stats: {
        total: quality.coverage.total,
        cited: quality.coverage.cited,
        ratio: quality.coverage.ratio,
        empty_fields: quality.empty_fields.length,
        attempt,
      },
      ...(quality.ok
        ? {}
        : {
            error_code: "QUALITY_GATE_FAILED",
            error_detail: quality.empty_fields.slice(0, 10).join(", "),
          }),
    });

    if (evidence.ok && quality.ok) {
      report.final = {
        ok: true,
        unknown_ids_count: 0,
        empty_fields_count: 0,
        coverage_ratio: quality.coverage.ratio,
        attempts_used: attempt,
      };
      return { ok: true, canonical, report };
    }

    const missingKeys = computeMissingCitationKeys(canonical, true);
    if (attempt >= maxRepairAttempts || missingKeys.length === 0) {
      report.final = {
        ok: false,
        reason: evidence.ok ? "quality gate failed" : "evidence gate failed",
        unknown_ids_count: evidence.unknown_ids.length,
        empty_fields_count: quality.empty_fields.length,
        coverage_ratio: quality.coverage.ratio,
        attempts_used: attempt,
      };
      return { ok: false, report };
    }

    try {
      const repaired = await repairCitationsWithPatch({
        repo: params.repo,
        iter: params.iter,
        attempt: attempt + 1,
        missingKeys,
        allowedEvidenceIds: params.allowedEvidenceIds,
        evidenceLines: params.evidenceLines,
        provider: params.provider,
        model: params.model,
        temperature: params.temperature,
        run_id: params.run_id,
        onAudit: params.onAudit,
        onEvent: params.onEvent,
      });
      const unknownFromPatch = unknownIdsFromPatch(repaired.patch, params.allowedEvidenceIds);
      if (unknownFromPatch.length > 0) {
        report.stages.push({
          name: "repair",
          ok: false,
          error_code: "REPAIR_PATCH_UNKNOWN_ID",
          error_detail: unknownFromPatch.join(", "),
          stats: { attempt: attempt + 1, missing_keys_count: missingKeys.length },
        });
        continue;
      }
      canonical = applyCitationsPatch(canonical, repaired.patch);
      report.stages.push({
        name: "repair",
        ok: true,
        stats: { attempt: attempt + 1, missing_keys_count: missingKeys.length },
      });
      params.onEvent?.("REPAIR_PATCH_APPLIED", {
        repo: params.repo,
        iter: params.iter,
        attempt: attempt + 1,
        patched_keys_count: Object.keys(repaired.patch).length,
      });
    } catch (error) {
      report.stages.push({
        name: "repair",
        ok: false,
        error_code: "REPAIR_PATCH_FAILED",
        error_detail: error instanceof Error ? error.message : String(error),
        stats: { attempt: attempt + 1, missing_keys_count: missingKeys.length },
      });
    }
  }

  report.final = { ok: false, reason: "bridge exhausted", attempts_used: maxRepairAttempts };
  return { ok: false, report };
}
