import type { BridgeReport } from "./bridge/types";
import type { FailKind } from "./types";

export function classifyFailure(params: {
  error?: string | null;
  report?: BridgeReport | null;
  isFetchError?: boolean;
  budgetCutoff?: boolean;
  gapItersUsed?: number;
  maxGapIters?: number;
  evidenceAddedTotal?: number;
}): { kind: FailKind; message: string; hints: string[] } {
  const error = (params.error ?? "").toLowerCase();
  const report = params.report;

  if (params.budgetCutoff) {
    return {
      kind: "BUDGET_CUTOFF",
      message: "Stopped by budget policy.",
      hints: ["Increase budget limits or reduce max repos per run"],
    };
  }
  if (params.isFetchError || error.includes("github api") || error.includes("fetch")) {
    return {
      kind: "FETCH_FAILED",
      message: params.error ?? "Fetch failed",
      hints: ["Check GITHUB_TOKEN scopes", "Check API rate limit", "Retry later"],
    };
  }
  if (report?.final.unknown_ids_count && report.final.unknown_ids_count > 0) {
    return {
      kind: "EVIDENCE_GATE_UNKNOWN_ID",
      message: "Unknown evidence ids in citations.",
      hints: ["Ensure citations ids are copied from allowedEvidenceIds only"],
    };
  }
  if (report?.final.empty_fields_count && report.final.empty_fields_count > 0) {
    return {
      kind: "QUALITY_GATE_EMPTY_CITATIONS",
      message: "Some required citation fields are empty.",
      hints: [
        "Improve synthesizer citations prompt",
        "Add citationHints",
        "Check evidence lines formatting",
      ],
    };
  }
  if (typeof report?.final.coverage_ratio === "number" && report.final.coverage_ratio < 1) {
    return {
      kind: "QUALITY_GATE_LOW_COVERAGE",
      message: "Coverage ratio below required threshold.",
      hints: ["Increase citation coverage and keep all key fields non-empty"],
    };
  }
  if (
    report?.stages.some((s) => s.name === "wire_validate" && !s.ok) ||
    error.includes("wire validation")
  ) {
    return {
      kind: "BRIDGE_WIRE_INVALID",
      message: "Wire schema validation failed.",
      hints: ["Constrain synthesizer output shape more tightly"],
    };
  }
  if (
    report?.stages.some((s) => s.name === "canonical_validate" && !s.ok) ||
    error.includes("canonical")
  ) {
    return {
      kind: "BRIDGE_CANONICAL_INVALID",
      message: "Canonical schema validation failed.",
      hints: ["Normalize citations map and ensure all canonical required keys exist"],
    };
  }
  const repairAttempts = report?.stages.filter((s) => s.name === "repair").length ?? 0;
  if (repairAttempts >= 2 && report?.final.ok === false) {
    return {
      kind: "REPAIR_EXHAUSTED",
      message: "Repair attempts exhausted.",
      hints: ["Tighten synthesizer template", "Increase evidence quality before synthesis"],
    };
  }
  if (
    (params.gapItersUsed ?? 0) >= (params.maxGapIters ?? 0) &&
    (params.evidenceAddedTotal ?? 0) >= 5 &&
    report?.final.ok === false
  ) {
    return {
      kind: "EVIDENCE_INSUFFICIENT",
      message: "Gap loop exhausted with insufficient evidence coverage.",
      hints: [
        "Increase issuesExtraLimit",
        "Enable readmeFallback",
        "Raise evidenceMaxTotal slightly",
      ],
    };
  }
  return {
    kind: "UNKNOWN",
    message: params.error ?? report?.final.reason ?? "Unknown failure",
    hints: ["Inspect report artifact and llm_audits for details"],
  };
}
