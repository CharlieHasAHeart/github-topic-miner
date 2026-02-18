export interface MinerConfig {
  topics: string[];
  perTopicLimit: number;
  minStars: number;
  pushedWithinDays: number;
  maxNewReposPerRun: number;
  maxItersGapLoop: number;
  allowRefresh?: boolean;
  refreshIfPushedAfter?: string | null;
  llm: {
    provider?: "openai" | "anthropic" | "gemini" | "qwen" | "deepseek";
    model: string;
    temperature: number;
  };
  output: {
    specDir: string;
    runsDir: string;
  };
  gapLoop?: {
    enabled: boolean;
    maxIters: number;
    evidenceMaxTotal: number;
    readmeFallbackEnabled: boolean;
    readmeFallbackPaths: string[];
    issuesExtraLimit: number;
    issuesKeywordBoost: boolean;
    issuesKeywordTopK: number;
    releasesExtraLimit: number;
    rerunStrategy: "bridge_only" | "synth_only" | "full";
    writeReportsEachIter: boolean;
  };
  budget?: {
    enabled: boolean;
    maxReposPerRun: number;
    maxGapItersPerRepo: number;
    maxLlmCallsPerRepo: number;
    maxRepairAttempts: number;
    maxEvidenceLinesForPrompt: number;
    maxWallTimeSeconds: number;
    maxTotalLlmCallsPerRun: number;
    maxTotalTokensApproxPerRun: number;
    maxTotalCostUsd?: number | null;
  };
  regression?: {
    enabled: boolean;
    suiteName: string;
    repos: string[];
    runMode: "bridge_only" | "synth_only" | "full";
    outputDir: string;
    failOnRegressionDrop: boolean;
    thresholds: {
      minSpecsSucceeded: number;
      maxAvgAttemptsUsed: number;
      maxAvgGapIters: number;
    };
  };
  pruning?: {
    enabled: boolean;
    iter2PlusStrategy: "synth_only" | "bridge_only" | "full";
    skipScoutInventorWhenIterGt1: boolean;
    skipEngineerWhenIterGt1: boolean;
    rerunSynthWithoutEnrichOnce: boolean;
  };
}

export interface CandidateRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license_spdx_id: string | null;
  default_branch: string;
  pushed_at: string;
  created_at: string;
}

export interface RepoCardReadme {
  fetched: boolean;
  text: string | null;
  truncated: boolean;
  bytes?: number | null;
  source?: "api" | "raw" | "none";
}

export interface RepoCardReleaseItem {
  name: string | null;
  tag_name: string | null;
  published_at: string | null;
  body_excerpt: string | null;
}

export interface RepoCardIssueItem {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
}

export type EvidenceType = "readme" | "issue" | "release" | "root_files";

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  source_url: string;
  title: string;
  excerpt: string;
  fetched_at: string;
  meta?: {
    repo_full_name: string;
    number?: number;
    tag_name?: string;
    published_at?: string;
    path?: string;
    sha?: string | null;
    segment?: number;
    language?: string | null;
  };
}

export interface RepoCard {
  full_name: string;
  html_url: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license_spdx_id: string | null;
  default_branch: string;
  pushed_at: string;
  created_at: string;
  readme: RepoCardReadme;
  releases: {
    fetched: boolean;
    items: RepoCardReleaseItem[];
  };
  issues: {
    fetched: boolean;
    items: RepoCardIssueItem[];
  };
  root_files?: string[] | null;
  evidence: EvidenceItem[];
}

export interface GapItem {
  repo: string;
  kind: "readme" | "releases" | "issues" | "root_files";
  message: string;
}

export interface MinerStats {
  topics_searched: number;
  candidates_found: number;
  candidates_kept: number;
  candidates_deduped: number;
  new_candidates: number;
  repo_cards_built: number;
  gaps_count: number;
  evidence_total: number;
  evidence_by_type: {
    readme: number;
    issue: number;
    release: number;
    root_files: number;
  };
  specs_attempted: number;
  specs_succeeded: number;
  specs_failed: number;
  evidence_validated: number;
  evidence_valid_ok: number;
  evidence_valid_failed: number;
  evidence_written: number;
  evidence_write_failed: number;
}

export interface MinerIndexRepoEntry {
  last_seen_at: string;
  last_pushed_at: string;
  last_spec_path?: string | null;
  evidence_path?: string | null;
  last_run_id?: string | null;
  note?: string | null;
}

export interface MinerIndex {
  version: 1;
  updated_at: string;
  repos: Record<string, MinerIndexRepoEntry>;
}

export interface EvidenceReport {
  repo: string;
  ok: boolean;
  missing_evidence_ids: string[];
  invalid_structure: string[];
  coverage: {
    app: boolean;
    core_loop: boolean;
    screens: { total: number; cited: number };
    commands: { total: number; cited: number };
    tables: { total: number; cited: number };
    acceptance_tests: { total: number; cited: number };
    ratio: number;
  };
  unused_evidence_ids: string[];
  notes: string[];
}

export type EventLevel = "info" | "warn" | "error";

export interface MinerEvent {
  ts: string;
  run_id: string;
  node: string;
  repo?: string | null;
  level: EventLevel;
  event: string;
  data?: Record<string, unknown>;
}

export interface LlmAudit {
  ts: string;
  run_id: string;
  repo?: string | null;
  iter?: number;
  role: string;
  model: string;
  temperature: number;
  prompt_hash: string;
  input_stats: {
    evidence_count: number;
    approx_chars: number;
  };
  output_stats: {
    json_parse_ok: boolean;
    schema_ok: boolean;
    unknown_evidence_ids_count: number;
  };
  correction_retry: boolean;
  retry_count: number;
  duration_ms: number;
  prompt_chars?: number;
  completion_chars?: number;
  error?: string;
}

export type FailKind =
  | "FETCH_FAILED"
  | "EVIDENCE_INSUFFICIENT"
  | "BRIDGE_WIRE_INVALID"
  | "BRIDGE_CANONICAL_INVALID"
  | "EVIDENCE_GATE_UNKNOWN_ID"
  | "QUALITY_GATE_EMPTY_CITATIONS"
  | "QUALITY_GATE_LOW_COVERAGE"
  | "REPAIR_EXHAUSTED"
  | "BUDGET_CUTOFF"
  | "UNKNOWN";

export interface MinerState {
  run_id: string;
  generated_at: string;
  config: MinerConfig;
  index: MinerIndex;
  seed_candidates?: CandidateRepo[];
  candidates: CandidateRepo[];
  new_candidates: CandidateRepo[];
  repo_cards: RepoCard[];
  gaps: GapItem[];
  role_outputs: Record<
    string,
    {
      scout?: unknown;
      inventor?: unknown;
      engineer?: unknown;
      skeptic?: unknown;
      synth?: unknown;
    }
  >;
  spec_results: Array<{
    repo: string;
    ok: boolean;
    spec_path?: string;
    error?: string;
    fail_kind?: FailKind;
    fail_message?: string;
    hints?: string[];
  }>;
  evidence_results: Array<{
    repo: string;
    ok: boolean;
    evidence_path?: string;
    error?: string;
  }>;
  evidence_reports: EvidenceReport[];
  events: MinerEvent[];
  llm_audits: LlmAudit[];
  per_repo_bridge: Array<{
    repo: string;
    ok: boolean;
    coverage_ratio?: number;
    unknown_ids_count?: number;
    empty_fields_count?: number;
    attempts_used: number;
  }>;
  per_repo_gap_loop: Array<{
    repo: string;
    attempts_used: number;
    success: boolean;
    evidence_total_initial: number;
    evidence_total_final: number;
    evidence_added_total: number;
    last_error: string | null;
  }>;
  fail_taxonomy_summary: Record<FailKind, number>;
  stats: MinerStats;
  logs: string[];
  status: "ok" | "error";
  errors?: string[];
}
