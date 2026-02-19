import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBudgetManager, type BudgetConfig } from "./budget";
import { createMinerGraph } from "./graph";
import { fetchRepoByFullName } from "./github";
import { createLogger } from "./logger";
import { runRegressionSuite, type RegressionConfig } from "./regression";
import { finalizeTopicSelectionRun, selectTopicsForRun } from "./topics/selector";
import type { FailKind, MinerConfig, MinerState } from "./types";

const CONFIG_PATH = path.join("github-topic-miner", "config", "miner.config.json");

function collectEvidenceIds(value: unknown): string[] {
  const found = new Set<string>();
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === "evidence_ids" && Array.isArray(child)) {
          for (const id of child) if (typeof id === "string") found.add(id);
        } else walk(child);
      }
    }
  }
  walk(value);
  return [...found];
}

function formatRunId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").replace("T", "T");
}

function defaultFailTaxonomySummary(): Record<FailKind, number> {
  return {
    FETCH_FAILED: 0,
    EVIDENCE_INSUFFICIENT: 0,
    BRIDGE_WIRE_INVALID: 0,
    BRIDGE_CANONICAL_INVALID: 0,
    EVIDENCE_GATE_UNKNOWN_ID: 0,
    QUALITY_GATE_EMPTY_CITATIONS: 0,
    QUALITY_GATE_LOW_COVERAGE: 0,
    REPAIR_EXHAUSTED: 0,
    BUDGET_CUTOFF: 0,
    UNKNOWN: 0,
  };
}

function withDefaults(config: MinerConfig): MinerConfig {
  return {
    ...config,
    budget: {
      enabled: config.budget?.enabled ?? true,
      maxReposPerRun: config.budget?.maxReposPerRun ?? 10,
      maxGapItersPerRepo: config.budget?.maxGapItersPerRepo ?? 2,
      maxLlmCallsPerRepo: config.budget?.maxLlmCallsPerRepo ?? 8,
      maxRepairAttempts: config.budget?.maxRepairAttempts ?? 2,
      maxEvidenceLinesForPrompt: config.budget?.maxEvidenceLinesForPrompt ?? 30,
      maxWallTimeSeconds: config.budget?.maxWallTimeSeconds ?? 900,
      maxTotalLlmCallsPerRun: config.budget?.maxTotalLlmCallsPerRun ?? 60,
      maxTotalTokensApproxPerRun: config.budget?.maxTotalTokensApproxPerRun ?? 250000,
      maxTotalCostUsd: config.budget?.maxTotalCostUsd ?? null,
    },
    regression: {
      enabled: config.regression?.enabled ?? false,
      suiteName: config.regression?.suiteName ?? "baseline",
      repos: config.regression?.repos ?? [],
      runMode: config.regression?.runMode ?? "bridge_only",
      outputDir: config.regression?.outputDir ?? "regression",
      failOnRegressionDrop: config.regression?.failOnRegressionDrop ?? true,
      thresholds: {
        minSpecsSucceeded: config.regression?.thresholds.minSpecsSucceeded ?? 1,
        maxAvgAttemptsUsed: config.regression?.thresholds.maxAvgAttemptsUsed ?? 1.0,
        maxAvgGapIters: config.regression?.thresholds.maxAvgGapIters ?? 2.0,
      },
    },
    pruning: {
      enabled: config.pruning?.enabled ?? true,
      iter2PlusStrategy: config.pruning?.iter2PlusStrategy ?? "synth_only",
      skipScoutInventorWhenIterGt1: config.pruning?.skipScoutInventorWhenIterGt1 ?? true,
      skipEngineerWhenIterGt1: config.pruning?.skipEngineerWhenIterGt1 ?? true,
      rerunSynthWithoutEnrichOnce: config.pruning?.rerunSynthWithoutEnrichOnce ?? true,
    },
  };
}

function createInitialState(
  runId: string,
  generatedAt: string,
  config: MinerConfig,
  seedCandidates: MinerState["seed_candidates"] = [],
): MinerState {
  return {
    run_id: runId,
    generated_at: generatedAt,
    config,
    seed_candidates: seedCandidates,
    index: { version: 1, updated_at: generatedAt, repos: {} },
    candidates: [],
    new_candidates: [],
    repo_cards: [],
    gaps: [],
    role_outputs: {},
    spec_results: [],
    evidence_results: [],
    evidence_reports: [],
    events: [],
    llm_audits: [],
    per_repo_bridge: [],
    per_repo_gap_loop: [],
    fail_taxonomy_summary: defaultFailTaxonomySummary(),
    stats: {
      topics_searched: 0,
      candidates_found: 0,
      candidates_kept: 0,
      candidates_deduped: 0,
      new_candidates: 0,
      repo_cards_built: 0,
      gaps_count: 0,
      specs_attempted: 0,
      specs_succeeded: 0,
      specs_failed: 0,
      evidence_validated: 0,
      evidence_valid_ok: 0,
      evidence_valid_failed: 0,
      evidence_written: 0,
      evidence_write_failed: 0,
      evidence_total: 0,
      evidence_by_type: { readme: 0, issue: 0, release: 0, root_files: 0 },
    },
    logs: [],
    status: "ok",
  };
}

async function main() {
  let runId = formatRunId(new Date());
  const generatedAt = new Date().toISOString();
  let logger: ReturnType<typeof createLogger> | null = null;
  let config: MinerConfig | null = null;
  let topicSelectionSummary:
    | {
        enabled: boolean;
        batch_size: number;
        quotas: { core: number; adjacent: number; explore: number };
        source_path: string;
        state_path: string;
        skipped_by_cooldown: number;
        skipped_by_freeze: number;
      }
    | undefined;

  try {
    const configRaw = await readFile(CONFIG_PATH, "utf-8");
    config = withDefaults(JSON.parse(configRaw) as MinerConfig);
    logger = createLogger(runId);
    const selected = selectTopicsForRun(config, runId);
    config = { ...config, topics: selected.topics };
    topicSelectionSummary = selected.summary;
    logger.log({
      node: "bootstrap",
      level: "info",
      event: "TOPICS_SELECTED",
      data: {
        count: selected.topics.length,
        enabled: selected.summary.enabled,
        quotas: selected.summary.quotas,
      },
    });

    const budgetManager = createBudgetManager(config.budget as BudgetConfig, logger, runId);
    const graph = createMinerGraph(logger, budgetManager);
    const initialState = createInitialState(runId, generatedAt, config);
    const finalState = await graph.invoke(initialState);
    const topicResultCounts: Record<string, number> = {};
    for (const event of logger.getEvents()) {
      if (event.event !== "TOPIC_SEARCH_OK") continue;
      const data = event.data as { topic?: unknown; count?: unknown } | undefined;
      const topic = typeof data?.topic === "string" ? data.topic.toLowerCase() : "";
      const count = typeof data?.count === "number" ? data.count : 0;
      if (topic) topicResultCounts[topic] = count;
    }
    finalizeTopicSelectionRun(config, runId, topicResultCounts);

    const attemptsHist = { "0": 0, "1": 0, "2": 0 };
    for (const item of finalState.per_repo_bridge) {
      const key = String(Math.min(2, Math.max(0, item.attempts_used))) as "0" | "1" | "2";
      attemptsHist[key] += 1;
    }
    const totalRepos = finalState.per_repo_bridge.length;
    const attemptsSummary = {
      total_repos: totalRepos,
      attempts_used_hist: attemptsHist,
      attempts_used_rate0: totalRepos > 0 ? Number((attemptsHist["0"] / totalRepos).toFixed(4)) : 0,
    };
    logger.log({ node: "bootstrap", level: "info", event: "BRIDGE_ATTEMPTS_SUMMARY", data: attemptsSummary });

    let regressionResultPath: string | undefined;
    let regressionFailed = false;
    if (config.regression?.enabled) {
      logger.log({
        node: "bootstrap",
        level: "info",
        event: "REGRESSION_START",
        data: { suite: config.regression.suiteName, repos: config.regression.repos.length },
      });

      const regression = await runRegressionSuite({
        config: config.regression as RegressionConfig,
        run_id: runId,
        generated_at: generatedAt,
        runOneRepo: async (fullName) => {
          try {
            const candidate = await fetchRepoByFullName(fullName, process.env.GITHUB_TOKEN);
            const regressionConfig: MinerConfig = {
              ...config!,
              topics: [],
              maxNewReposPerRun: 1,
              regression: {
                ...(config!.regression as RegressionConfig),
                enabled: true,
                runMode: "bridge_only",
              },
            };
            const regressionGraph = createMinerGraph(logger ?? undefined);
            const subState = createInitialState(runId, generatedAt, regressionConfig, [candidate]);
            const out = await regressionGraph.invoke(subState);
            const spec = out.spec_results.find((x) => x.repo === fullName) ?? out.spec_results[0];
            const evidence = out.evidence_results.find((x) => x.repo === fullName) ?? out.evidence_results[0];
            const bridge = out.per_repo_bridge.find((x) => x.repo === fullName) ?? out.per_repo_bridge[0];
            const gap = out.per_repo_gap_loop.find((x) => x.repo === fullName) ?? out.per_repo_gap_loop[0];
            const llmCalls = out.llm_audits.filter((a) => a.repo === fullName).length;
            return {
              repo: fullName,
              ok: Boolean(spec?.ok),
              specs_written: Boolean(spec?.ok && spec.spec_path),
              evidence_written: Boolean(evidence?.ok && evidence.evidence_path),
              attempts_used: bridge?.attempts_used ?? 0,
              gap_iters_used: gap?.attempts_used ?? 0,
              llm_calls: llmCalls,
              fail_kind: spec?.fail_kind,
            };
          } catch {
            return {
              repo: fullName,
              ok: false,
              specs_written: false,
              evidence_written: false,
              attempts_used: 0,
              gap_iters_used: 0,
              llm_calls: 0,
              fail_kind: "FETCH_FAILED" as FailKind,
            };
          }
        },
      });
      regressionResultPath = regression.outputPath;
      regressionFailed = !regression.result.pass;
      logger.log({
        node: "bootstrap",
        level: regression.result.pass ? "info" : "warn",
        event: regression.result.pass ? "REGRESSION_OK" : "REGRESSION_FAIL",
        data: { output: regression.outputPath, summary: regression.result.summary },
      });
    }

    const budgetSnapshotEnd = budgetManager.snapshot();
    logger.log({
      node: "bootstrap",
      level: "info",
      event: "RUN_BUDGET_SUMMARY",
      data: { ...budgetSnapshotEnd },
    });
    logger.log({
      node: "bootstrap",
      level: "info",
      event: "RUN_FAIL_TAXONOMY_SUMMARY",
      data: finalState.fail_taxonomy_summary,
    });
    logger.log({
      node: "bootstrap",
      level: "info",
      event: "RUN_DONE",
      data: { specs_succeeded: finalState.stats.specs_succeeded, specs_failed: finalState.stats.specs_failed },
    });

    const runsDir = config.output?.runsDir ?? "runs";
    await mkdir(runsDir, { recursive: true });
    const outPath = path.join(runsDir, `${runId}.json`);
    const payload = {
      run_id: finalState.run_id,
      generated_at: finalState.generated_at,
      config_path: CONFIG_PATH,
      config: finalState.config,
      topic_selection_summary: topicSelectionSummary,
      status: finalState.status,
      stats: finalState.stats,
      index_summary: {
        version: finalState.index.version,
        updated_at: finalState.index.updated_at,
        repo_count: Object.keys(finalState.index.repos).length,
      },
      candidates: finalState.candidates,
      new_candidates: finalState.new_candidates,
      repo_cards: finalState.repo_cards,
      repo_cards_summary: finalState.repo_cards.map((card) => {
        const evidenceByType = card.evidence.reduce(
          (acc, item) => {
            acc[item.type] += 1;
            return acc;
          },
          { readme: 0, issue: 0, release: 0, root_files: 0 },
        );
        return {
          full_name: card.full_name,
          evidence_count: card.evidence.length,
          evidence_by_type: evidenceByType,
          readme_truncated: card.readme.truncated,
          issues_count: card.issues.items.length,
          releases_count: card.releases.items.length,
        };
      }),
      gaps: finalState.gaps,
      spec_results: finalState.spec_results,
      evidence_results: finalState.evidence_results,
      evidence_reports: finalState.evidence_reports,
      llm_audits: finalState.llm_audits,
      per_repo_bridge: finalState.per_repo_bridge,
      per_repo_gap_loop: finalState.per_repo_gap_loop,
      bridge_attempts_summary: attemptsSummary,
      gap_loop_summary: {
        total: finalState.per_repo_gap_loop.length,
        success: finalState.per_repo_gap_loop.filter((x) => x.success).length,
      },
      fail_taxonomy_summary: finalState.fail_taxonomy_summary,
      budget_snapshot_end: budgetSnapshotEnd,
      regression_result_path: regressionResultPath,
      regression_failed: regressionFailed || undefined,
      role_outputs: finalState.role_outputs,
      role_outputs_summary: Object.entries(finalState.role_outputs).map(([repo, outputs]) => {
        const roleStatus = {
          scout: Boolean(outputs.scout),
          inventor: Boolean(outputs.inventor),
          engineer: Boolean(outputs.engineer),
          skeptic: Boolean(outputs.skeptic),
          synth: Boolean(outputs.synth),
        };
        const evidenceIdsByRole = {
          scout: collectEvidenceIds(outputs.scout).length,
          inventor: collectEvidenceIds(outputs.inventor).length,
          engineer: collectEvidenceIds(outputs.engineer).length,
          skeptic: collectEvidenceIds(outputs.skeptic).length,
          synth: collectEvidenceIds(outputs.synth).length,
        };
        const failed = finalState.spec_results.find((item) => item.repo === repo && !item.ok);
        return {
          repo,
          role_status: roleStatus,
          evidence_ids_count: evidenceIdsByRole,
          error: failed?.error,
        };
      }),
      logs: finalState.logs,
      events: logger.getEvents(),
      artifacts_summary: {
        spec_dir: path.join("specs", finalState.generated_at.slice(0, 10)),
        evidence_dir: path.join("evidence", finalState.generated_at.slice(0, 10)),
      },
      ...(finalState.errors ? { errors: finalState.errors } : {}),
    };

    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    console.log(`Run written: ${outPath}`);
  } catch (error) {
    const runsDir = "runs";
    await mkdir(runsDir, { recursive: true });
    runId = runId || formatRunId(new Date());
    const outPath = path.join(runsDir, `${runId}.json`);
    const message = error instanceof Error ? error.message : String(error);

    const payload = {
      run_id: runId,
      generated_at: generatedAt,
      config_path: CONFIG_PATH,
      ...(config ? { config } : {}),
      ...(topicSelectionSummary ? { topic_selection_summary: topicSelectionSummary } : {}),
      status: "error",
      stats: {
        topics_searched: 0,
        candidates_found: 0,
        candidates_kept: 0,
        candidates_deduped: 0,
        new_candidates: 0,
        repo_cards_built: 0,
        gaps_count: 0,
        specs_attempted: 0,
        specs_succeeded: 0,
        specs_failed: 0,
        evidence_validated: 0,
        evidence_valid_ok: 0,
        evidence_valid_failed: 0,
        evidence_written: 0,
        evidence_write_failed: 0,
        evidence_total: 0,
        evidence_by_type: { readme: 0, issue: 0, release: 0, root_files: 0 },
      },
      index_summary: { version: 1, updated_at: generatedAt, repo_count: 0 },
      candidates: [],
      new_candidates: [],
      repo_cards: [],
      repo_cards_summary: [],
      gaps: [],
      spec_results: [],
      evidence_results: [],
      evidence_reports: [],
      llm_audits: [],
      per_repo_bridge: [],
      per_repo_gap_loop: [],
      bridge_attempts_summary: {
        total_repos: 0,
        attempts_used_hist: { "0": 0, "1": 0, "2": 0 },
        attempts_used_rate0: 0,
      },
      gap_loop_summary: { total: 0, success: 0 },
      fail_taxonomy_summary: defaultFailTaxonomySummary(),
      budget_snapshot_end: null,
      role_outputs: {},
      role_outputs_summary: [],
      logs: [],
      events: logger?.getEvents() ?? [],
      artifacts_summary: {
        spec_dir: path.join("specs", generatedAt.slice(0, 10)),
        evidence_dir: path.join("evidence", generatedAt.slice(0, 10)),
      },
      errors: [message],
    };

    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    console.error(`Run failed. Log written: ${outPath}`);
    process.exitCode = 1;
  }
}

void main();
