import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  buildDatedDirName,
  toSafeRepoFileName,
  writeEvidenceArtifact,
  writeReportArtifact,
} from "./artifacts";
import { mapLimit } from "./concurrency";
import {
  buildEvidencePack,
  extractGapKeywords,
  selectEvidenceForLLM,
  type EvidenceFocusHint,
} from "./evidence";
import { enrichEvidence } from "./enrich";
import { classifyFailure } from "./failures";
import {
  fetchLatestReleases,
  fetchReadmeText,
  fetchRecentIssues,
  fetchRootFiles,
  searchReposByTopic,
} from "./github";
import {
  loadIndex,
  saveIndex,
  updateIndexEvidencePath,
  updateIndexSeen,
  updateIndexSpecPath,
} from "./index";
import { chatJSONRaw } from "./llm";
import {
  buildWireSynthPrompts,
  evidenceLinesForPrompt,
} from "./prompts";
import type { createLogger } from "./logger";
import type { MinerState } from "./types";
import { runBridge } from "./bridge/runBridge";
import type { createBudgetManager } from "./budget";

type MinerLogger = ReturnType<typeof createLogger>;
type BudgetManager = ReturnType<typeof createBudgetManager>;

function buildFocusHintFromReport(
  report: Awaited<ReturnType<typeof runBridge>>["report"] | null,
): EvidenceFocusHint {
  if (!report) return {};
  const notes = report.stages
    .map((stage) => `${stage.error_code ?? ""} ${stage.error_detail ?? ""}`)
    .join(" ")
    .toLowerCase();
  const hint: EvidenceFocusHint = {
    need_commands: notes.includes("command"),
    need_tests: notes.includes("acceptance") || notes.includes("test"),
    need_tables: notes.includes("table") || notes.includes("schema"),
    need_screens: notes.includes("screen"),
    need_core: notes.includes("core_loop") || notes.includes("core loop"),
    keywords: extractGapKeywords({ report, emptyFields: [] }),
  };
  return hint;
}

function focusHintSummary(hint: EvidenceFocusHint): Record<string, unknown> {
  return {
    need_commands: Boolean(hint.need_commands),
    need_tests: Boolean(hint.need_tests),
    need_tables: Boolean(hint.need_tables),
    need_screens: Boolean(hint.need_screens),
    need_core: Boolean(hint.need_core),
    keywords_count: hint.keywords?.length ?? 0,
  };
}

export function createMinerGraph(logger?: MinerLogger, budget?: BudgetManager) {
  const emit = logger?.log
    ? logger.log
    : (_event: {
        node: string;
        repo?: string | null;
        level: "info" | "warn" | "error";
        event: string;
        data?: Record<string, unknown>;
      }) => {};

  const MinerStateAnnotation = Annotation.Root({
    seed_candidates: Annotation<MinerState["seed_candidates"]>(),
    run_id: Annotation<string>(),
    generated_at: Annotation<string>(),
    config: Annotation<MinerState["config"]>(),
    index: Annotation<MinerState["index"]>(),
    candidates: Annotation<MinerState["candidates"]>(),
    new_candidates: Annotation<MinerState["new_candidates"]>(),
    repo_cards: Annotation<MinerState["repo_cards"]>(),
    gaps: Annotation<MinerState["gaps"]>(),
    role_outputs: Annotation<MinerState["role_outputs"]>(),
    spec_results: Annotation<MinerState["spec_results"]>(),
    evidence_results: Annotation<MinerState["evidence_results"]>(),
    evidence_reports: Annotation<MinerState["evidence_reports"]>(),
    events: Annotation<MinerState["events"]>(),
    llm_audits: Annotation<MinerState["llm_audits"]>(),
    per_repo_bridge: Annotation<MinerState["per_repo_bridge"]>(),
    per_repo_gap_loop: Annotation<MinerState["per_repo_gap_loop"]>(),
    fail_taxonomy_summary: Annotation<MinerState["fail_taxonomy_summary"]>(),
    stats: Annotation<MinerState["stats"]>(),
    logs: Annotation<MinerState["logs"]>(),
    status: Annotation<MinerState["status"]>(),
    errors: Annotation<MinerState["errors"]>(),
  });

  return new StateGraph(MinerStateAnnotation)
    .addNode("bootstrap", (state: MinerState): MinerState => {
      emit({
        node: "bootstrap",
        level: "info",
        event: "RUN_START",
        data: { run_id: state.run_id },
      });
      emit({
        node: "bootstrap",
        level: "info",
        event: "RUN_CONFIG_LOADED",
        data: { topics: state.config.topics.length, model: state.config.llm.model },
      });
      return {
        ...state,
        index: state.index ?? {
          version: 1,
          updated_at: new Date().toISOString(),
          repos: {},
        },
        seed_candidates: state.seed_candidates ?? [],
        candidates: state.candidates ?? [],
        new_candidates: state.new_candidates ?? [],
        repo_cards: state.repo_cards ?? [],
        gaps: state.gaps ?? [],
        role_outputs: state.role_outputs ?? {},
        spec_results: state.spec_results ?? [],
        evidence_results: state.evidence_results ?? [],
        evidence_reports: state.evidence_reports ?? [],
        events: state.events ?? [],
        llm_audits: state.llm_audits ?? [],
        per_repo_bridge: state.per_repo_bridge ?? [],
        per_repo_gap_loop: state.per_repo_gap_loop ?? [],
        fail_taxonomy_summary: state.fail_taxonomy_summary ?? {
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
        },
        stats: state.stats ?? {
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
          evidence_by_type: {
            readme: 0,
            issue: 0,
            release: 0,
            root_files: 0,
          },
        },
        logs: state.logs ?? [],
        status: "ok",
      };
    })
    .addNode("repo_finder", async (state: MinerState): Promise<MinerState> => {
      if (budget?.shouldStopRun().stop) {
        return state;
      }
      if (
        state.config.regression?.enabled &&
        state.config.regression.runMode === "bridge_only" &&
        (state.seed_candidates?.length ?? 0) > 0
      ) {
        const seeded = (state.seed_candidates ?? []).slice(0, state.config.maxNewReposPerRun);
        return {
          ...state,
          candidates: seeded,
          stats: {
            ...state.stats,
            topics_searched: 0,
            candidates_found: state.seed_candidates?.length ?? 0,
            candidates_kept: seeded.length,
          },
          logs: [...state.logs, `[repo_finder] regression seed candidates=${seeded.length}`],
          status: "ok",
        };
      }
      const token = process.env.GITHUB_TOKEN;
      const logs = [...state.logs];
      const merged: MinerState["candidates"] = [];

      for (const topic of state.config.topics) {
        emit({
          node: "repo_finder",
          level: "info",
          event: "TOPIC_SEARCH_START",
          data: { topic },
        });
        try {
          const repos = await searchReposByTopic({
            topic,
            perTopicLimit: state.config.perTopicLimit,
            minStars: state.config.minStars,
            pushedWithinDays: state.config.pushedWithinDays,
            token,
            appendLog: (line) => logs.push(line),
          });
          logs.push(`[repo_finder] topic="${topic}" returned=${repos.length}`);
          emit({
            node: "repo_finder",
            level: "info",
            event: "TOPIC_SEARCH_OK",
            data: { topic, count: repos.length },
          });
          merged.push(...repos);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emit({
            node: "repo_finder",
            level: "error",
            event: "TOPIC_SEARCH_FAIL",
            data: { topic, error: message },
          });
          throw error;
        }
      }

      const sorted = merged.sort((a, b) => {
        return new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime();
      });
      const kept = sorted.slice(0, state.config.maxNewReposPerRun);

      logs.push(
        `[repo_finder] total_found=${merged.length} kept=${kept.length} limit=${state.config.maxNewReposPerRun}`,
      );

      return {
        ...state,
        candidates: kept,
        stats: {
          ...state.stats,
          topics_searched: state.config.topics.length,
          candidates_found: merged.length,
          candidates_kept: kept.length,
        },
        logs,
        status: "ok",
      };
    })
    .addNode("deduper", (state: MinerState): MinerState => {
      if (state.config.regression?.enabled && state.config.regression.runMode === "bridge_only") {
        return {
          ...state,
          new_candidates: state.candidates,
          stats: {
            ...state.stats,
            candidates_deduped: 0,
            new_candidates: state.candidates.length,
          },
          logs: [...state.logs, "[deduper] regression mode bypass dedupe"],
          status: "ok",
        };
      }
      const index = loadIndex();
      const logs = [...state.logs];
      const existingCount = Object.keys(index.repos).length;
      emit({
        node: "deduper",
        level: "info",
        event: "INDEX_LOADED",
        data: { repo_count: existingCount },
      });
      const allowRefresh = state.config.allowRefresh ?? false;
      let refreshTriggered = 0;

      const filtered = state.candidates.filter((candidate) => {
        const entry = index.repos[candidate.full_name];
        if (!entry) {
          return true;
        }
        if (allowRefresh && candidate.pushed_at > entry.last_pushed_at) {
          refreshTriggered += 1;
          return true;
        }
        return false;
      });

      const sorted = filtered.sort((a, b) => {
        return new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime();
      });
      const kept = sorted.slice(0, state.config.maxNewReposPerRun);

      for (const candidate of state.candidates) {
        updateIndexSeen(index, candidate.full_name, candidate.pushed_at, state.run_id);
      }
      saveIndex(index);

      const skipped = state.candidates.length - kept.length;
      logs.push(`[deduper] existing_index_repos=${existingCount}`);
      logs.push(
        `[deduper] candidates_total=${state.candidates.length} new=${kept.length} skipped=${skipped}`,
      );
      if (allowRefresh) {
        logs.push(`[deduper] allow_refresh=true refreshed=${refreshTriggered}`);
      }
      emit({
        node: "deduper",
        level: "info",
        event: "DEDUPE_DONE",
        data: {
          total: state.candidates.length,
          kept: kept.length,
          skipped,
          refreshed: refreshTriggered,
        },
      });

      return {
        ...state,
        index,
        new_candidates: kept,
        stats: {
          ...state.stats,
          candidates_deduped: state.candidates.length - kept.length,
          new_candidates: kept.length,
        },
        logs,
        status: "ok",
      };
    })
    .addNode("repo_card_builder", async (state: MinerState): Promise<MinerState> => {
      const token = process.env.GITHUB_TOKEN;
      const logs = [...state.logs];
      const gaps = [...state.gaps];

      const repoCards = await mapLimit(state.new_candidates, 3, async (repo) => {
        const card: MinerState["repo_cards"][number] = {
          ...repo,
          readme: {
            fetched: false,
            text: null,
            truncated: false,
            bytes: null,
            source: "none",
          },
          releases: { fetched: false, items: [] },
          issues: { fetched: false, items: [] },
          root_files: null,
          evidence: [],
        };
        let cacheHits = 0;
        let cacheMisses = 0;
        const onCacheEvent = (event: "CACHE_HIT" | "CACHE_MISS", data: { repo: string; key: string }) => {
          if (event === "CACHE_HIT") cacheHits += 1;
          else cacheMisses += 1;
          emit({
            node: "repo_card_builder",
            repo: data.repo,
            level: "info",
            event,
            data: { key: data.key },
          });
        };
        const onRetryEvent = (
          event: "GITHUB_RETRY" | "GITHUB_RETRY_GIVEUP",
          data: { repo: string; endpoint: string; attempt: number; status?: number; reason?: string },
        ) => {
          emit({
            node: "repo_card_builder",
            repo: data.repo,
            level: event === "GITHUB_RETRY" ? "warn" : "error",
            event,
            data,
          });
        };
        const batchStart = Date.now();
        emit({
          node: "repo_card_builder",
          repo: repo.full_name,
          level: "info",
          event: "GITHUB_FETCH_BATCH_START",
          data: {},
        });
        const [readmeRes, releasesRes, issuesRes, rootFilesRes] = await Promise.allSettled([
          fetchReadmeText(repo.full_name, token, { onCacheEvent, onRetryEvent }),
          fetchLatestReleases(repo.full_name, token, 3, { onCacheEvent, onRetryEvent }),
          fetchRecentIssues(repo.full_name, token, 10, { onCacheEvent, onRetryEvent }),
          fetchRootFiles(repo.full_name, repo.default_branch, token, { onCacheEvent, onRetryEvent }),
        ]);

        if (readmeRes.status === "fulfilled") {
          const readme = readmeRes.value;
          card.readme = {
            fetched: true,
            text: readme.text,
            truncated: readme.truncated,
            bytes: readme.bytes,
            source: readme.source,
          };
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "info",
            event: "FETCH_README_OK",
            data: { bytes: readme.bytes, truncated: readme.truncated },
          });
        } else {
          const message = readmeRes.reason instanceof Error ? readmeRes.reason.message : String(readmeRes.reason);
          gaps.push({ repo: repo.full_name, kind: "readme", message });
          logs.push(`[repo_card_builder] ${repo.full_name} readme failed: ${message}`);
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "warn",
            event: "FETCH_README_FAIL",
            data: { error: message },
          });
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "error",
            event: "FETCH_FAILED_FINAL",
            data: { endpoint: "readme", reason: message },
          });
        }

        if (releasesRes.status === "fulfilled") {
          const releases = releasesRes.value;
          card.releases = { fetched: true, items: releases };
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "info",
            event: "FETCH_RELEASES_OK",
            data: { count: releases.length },
          });
        } else {
          const message = releasesRes.reason instanceof Error ? releasesRes.reason.message : String(releasesRes.reason);
          gaps.push({ repo: repo.full_name, kind: "releases", message });
          logs.push(`[repo_card_builder] ${repo.full_name} releases failed: ${message}`);
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "warn",
            event: "FETCH_RELEASES_FAIL",
            data: { error: message },
          });
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "error",
            event: "FETCH_FAILED_FINAL",
            data: { endpoint: "releases", reason: message },
          });
        }

        if (issuesRes.status === "fulfilled") {
          const issues = issuesRes.value;
          card.issues = { fetched: true, items: issues };
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "info",
            event: "FETCH_ISSUES_OK",
            data: { count: issues.length },
          });
        } else {
          const message = issuesRes.reason instanceof Error ? issuesRes.reason.message : String(issuesRes.reason);
          gaps.push({ repo: repo.full_name, kind: "issues", message });
          logs.push(`[repo_card_builder] ${repo.full_name} issues failed: ${message}`);
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "warn",
            event: "FETCH_ISSUES_FAIL",
            data: { error: message },
          });
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "error",
            event: "FETCH_FAILED_FINAL",
            data: { endpoint: "issues", reason: message },
          });
        }

        if (rootFilesRes.status === "fulfilled") {
          card.root_files = rootFilesRes.value;
        } else {
          const message =
            rootFilesRes.reason instanceof Error ? rootFilesRes.reason.message : String(rootFilesRes.reason);
          gaps.push({ repo: repo.full_name, kind: "root_files", message });
          logs.push(`[repo_card_builder] ${repo.full_name} root_files failed: ${message}`);
          emit({
            node: "repo_card_builder",
            repo: repo.full_name,
            level: "error",
            event: "FETCH_FAILED_FINAL",
            data: { endpoint: "root_files", reason: message },
          });
        }
        emit({
          node: "repo_card_builder",
          repo: repo.full_name,
          level: "info",
          event: "GITHUB_FETCH_BATCH_OK",
          data: { cached_hits: cacheHits, cached_misses: cacheMisses, duration_ms: Date.now() - batchStart },
        });

        const fetchedAt = new Date().toISOString();
        card.evidence = buildEvidencePack(card, fetchedAt);
        const readmeEvidenceCount = card.evidence.filter((item) => item.type === "readme").length;
        const issueEvidenceCount = card.evidence.filter((item) => item.type === "issue").length;
        const releaseEvidenceCount = card.evidence.filter((item) => item.type === "release").length;
        const rootFilesEvidenceCount = card.evidence.filter((item) => item.type === "root_files").length;
        emit({
          node: "repo_card_builder",
          repo: repo.full_name,
          level: "info",
          event: "EVIDENCE_PACK_BUILT",
          data: {
            total: card.evidence.length,
            readme: readmeEvidenceCount,
            issues: issueEvidenceCount,
            releases: releaseEvidenceCount,
            root_files: rootFilesEvidenceCount,
          },
        });
        logs.push(
          `[repo_card_builder] ${repo.full_name} evidence total=${card.evidence.length} readme=${readmeEvidenceCount} issue=${issueEvidenceCount} release=${releaseEvidenceCount} root_files=${rootFilesEvidenceCount}`,
        );

        return card;
      });

      const readmeSuccess = repoCards.filter((card) => card.readme.fetched).length;
      const evidenceByType = repoCards
        .flatMap((card) => card.evidence)
        .reduce(
          (acc, item) => {
            acc[item.type] += 1;
            return acc;
          },
          { readme: 0, issue: 0, release: 0, root_files: 0 },
        );
      const evidenceTotal =
        evidenceByType.readme +
        evidenceByType.issue +
        evidenceByType.release +
        evidenceByType.root_files;
      logs.push(
        `[repo_card_builder] built=${repoCards.length} readme_ok=${readmeSuccess}/${repoCards.length} evidence_total=${evidenceTotal} gaps=${gaps.length}`,
      );

      return {
        ...state,
        repo_cards: repoCards,
        gaps,
        stats: {
          ...state.stats,
          repo_cards_built: repoCards.length,
          gaps_count: gaps.length,
          evidence_total: evidenceTotal,
          evidence_by_type: evidenceByType,
        },
        logs,
        status: "ok",
      };
    })
    .addNode("llm_spec_generator", async (state: MinerState): Promise<MinerState> => {
      const logs = [...state.logs];
      const roleOutputs: MinerState["role_outputs"] = { ...state.role_outputs };
      const specResults: MinerState["spec_results"] = [];
      const evidenceResults: MinerState["evidence_results"] = [];
      const evidenceReports: MinerState["evidence_reports"] = [...state.evidence_reports];
      const llmAudits: MinerState["llm_audits"] = [...state.llm_audits];
      const perRepoBridge: MinerState["per_repo_bridge"] = [];
      const perRepoGapLoop: MinerState["per_repo_gap_loop"] = [];
      const failTaxonomySummary: MinerState["fail_taxonomy_summary"] = { ...state.fail_taxonomy_summary };
      const index = state.index;
      const dateDir = buildDatedDirName(state.generated_at);
      const gapLoop = {
        enabled: state.config.gapLoop?.enabled ?? true,
        maxIters: state.config.gapLoop?.maxIters ?? state.config.maxItersGapLoop ?? 2,
        evidenceMaxTotal: state.config.gapLoop?.evidenceMaxTotal ?? 30,
        readmeFallbackEnabled: state.config.gapLoop?.readmeFallbackEnabled ?? true,
        readmeFallbackPaths: state.config.gapLoop?.readmeFallbackPaths ?? [
          "README.md",
          "docs/README.md",
          "docs/index.md",
        ],
        issuesExtraLimit: state.config.gapLoop?.issuesExtraLimit ?? 25,
        issuesKeywordBoost: state.config.gapLoop?.issuesKeywordBoost ?? true,
        issuesKeywordTopK: state.config.gapLoop?.issuesKeywordTopK ?? 12,
        releasesExtraLimit: state.config.gapLoop?.releasesExtraLimit ?? 5,
        rerunStrategy: state.config.gapLoop?.rerunStrategy ?? "synth_only",
        writeReportsEachIter: state.config.gapLoop?.writeReportsEachIter ?? true,
      } as const;
      const pruning = {
        enabled: state.config.pruning?.enabled ?? true,
        iter2PlusStrategy: state.config.pruning?.iter2PlusStrategy ?? "synth_only",
        skipScoutInventorWhenIterGt1: state.config.pruning?.skipScoutInventorWhenIterGt1 ?? true,
        skipEngineerWhenIterGt1: state.config.pruning?.skipEngineerWhenIterGt1 ?? true,
        rerunSynthWithoutEnrichOnce: state.config.pruning?.rerunSynthWithoutEnrichOnce ?? true,
      } as const;

      let specsSucceeded = 0;
      let specsFailed = 0;
      let evidenceValidated = 0;
      let evidenceValidOk = 0;
      let evidenceValidFailed = 0;
      let evidenceWritten = 0;
      let evidenceWriteFailed = 0;

      for (const sourceRepoCard of state.repo_cards) {
        if (budget?.shouldStopRun().stop) {
          break;
        }
        let repoCard = sourceRepoCard;
        budget?.beginRepo(repoCard.full_name);
        const repoBudgetCheck = budget?.shouldStopRepo(repoCard.full_name);
        if (repoBudgetCheck?.stop) {
          const classified = classifyFailure({
            error: repoBudgetCheck.reason,
            budgetCutoff: true,
          });
          failTaxonomySummary[classified.kind] += 1;
          specResults.push({
            repo: repoCard.full_name,
            ok: false,
            error: repoBudgetCheck.reason,
            fail_kind: classified.kind,
            fail_message: classified.message,
            hints: classified.hints,
          });
          evidenceResults.push({ repo: repoCard.full_name, ok: false, error: "budget cutoff" });
          perRepoGapLoop.push({
            repo: repoCard.full_name,
            attempts_used: 0,
            success: false,
            evidence_total_initial: repoCard.evidence.length,
            evidence_total_final: repoCard.evidence.length,
            evidence_added_total: 0,
            last_error: repoBudgetCheck.reason ?? "budget cutoff",
          });
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "warn",
            event: "FAIL_CLASSIFIED",
            data: { kind: classified.kind },
          });
          continue;
        }
        roleOutputs[repoCard.full_name] = {};
        const initialEvidenceTotal = repoCard.evidence.length;
        let finalBridge:
          | {
              ok: boolean;
              canonical?: Awaited<ReturnType<typeof runBridge>>["canonical"];
              report: Awaited<ReturnType<typeof runBridge>>["report"];
              iter: number;
            }
          | null = null;
        let usedIterations = 0;
        let addedEvidenceTotal = 0;
        let lastError: string | null = null;
        let lastWireRaw: string | null = null;
        let lastBridgeReport: Awaited<ReturnType<typeof runBridge>>["report"] | null = null;
        let didRerunSynthWithoutEnrich = false;
        const maxIters = gapLoop.enabled
          ? Math.max(1, Math.min(gapLoop.maxIters, state.config.budget?.maxGapItersPerRepo ?? gapLoop.maxIters))
          : 1;
        try {
        const handleAudit = (audit: MinerState["llm_audits"][number]) => {
          llmAudits.push(audit);
          if (typeof audit.prompt_chars === "number" && typeof audit.completion_chars === "number") {
            budget?.recordLlmCall(repoCard.full_name, audit.prompt_chars, audit.completion_chars, {
              role: audit.role,
              iter: audit.iter,
            });
          }
        };

        for (let iter = 1; iter <= maxIters; iter += 1) {
          usedIterations = iter;
          const focusHint = iter > 1 ? buildFocusHintFromReport(lastBridgeReport) : {};
          const selectedEvidence = selectEvidenceForLLM(
            repoCard.evidence,
            Math.min(
              gapLoop.evidenceMaxTotal,
              state.config.budget?.maxEvidenceLinesForPrompt ?? gapLoop.evidenceMaxTotal,
            ),
            focusHint,
          );
          const allowedEvidenceIds = repoCard.evidence.map((item) => item.id);
          const evidenceLines = evidenceLinesForPrompt(selectedEvidence);
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "info",
            event: "EVIDENCE_SELECTED",
            data: {
              iter,
              selected_count: selectedEvidence.length,
              focusHintSummary: focusHintSummary(focusHint),
              type_counts: selectedEvidence.reduce(
                (acc, item) => {
                  acc[item.type] += 1;
                  return acc;
                },
                { readme: 0, issue: 0, release: 0, root_files: 0 },
              ),
            },
          });
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "info",
            event: "GAP_ITER_START",
            data: {
              iter,
              evidence_total: repoCard.evidence.length,
              evidence_selected: selectedEvidence.length,
              rerun_strategy: iter >= 2 && pruning.enabled ? pruning.iter2PlusStrategy : gapLoop.rerunStrategy,
            },
          });
          if (iter >= 2 && pruning.enabled) {
            emit({
              node: "llm_spec_generator",
              repo: repoCard.full_name,
              level: "info",
              event: "PRUNE_ITER_STRATEGY",
              data: { iter, strategy: pruning.iter2PlusStrategy },
            });
            if (pruning.skipScoutInventorWhenIterGt1) {
              emit({
                node: "llm_spec_generator",
                repo: repoCard.full_name,
                level: "info",
                event: "PRUNE_SKIP_ROLE",
                data: { iter, role: "scout", reason: "iter>1 pruning" },
              });
              emit({
                node: "llm_spec_generator",
                repo: repoCard.full_name,
                level: "info",
                event: "PRUNE_SKIP_ROLE",
                data: { iter, role: "inventor", reason: "iter>1 pruning" },
              });
            }
            if (pruning.skipEngineerWhenIterGt1) {
              emit({
                node: "llm_spec_generator",
                repo: repoCard.full_name,
                level: "info",
                event: "PRUNE_SKIP_ROLE",
                data: { iter, role: "engineer", reason: "iter>1 pruning" },
              });
              emit({
                node: "llm_spec_generator",
                repo: repoCard.full_name,
                level: "info",
                event: "PRUNE_SKIP_ROLE",
                data: { iter, role: "skeptic", reason: "iter>1 pruning" },
              });
            }
          }

          let wireRawContent = "";
          try {
            const iterStrategy =
              iter >= 2 && pruning.enabled ? pruning.iter2PlusStrategy : gapLoop.rerunStrategy;
            const shouldRunSynth =
              iter === 1 ||
              iterStrategy === "synth_only" ||
              iterStrategy === "full" ||
              !lastWireRaw;

            if (shouldRunSynth) {
              const { systemPrompt, userPrompt } = buildWireSynthPrompts({
                ...repoCard,
                evidence: selectedEvidence,
              });
              const wireRaw = await chatJSONRaw({
                systemPrompt,
                userPrompt,
                provider: state.config.llm.provider,
                model: state.config.llm.model,
                temperature: state.config.llm.temperature,
                audit: {
                  run_id: state.run_id,
                  repo: repoCard.full_name,
                  iter,
                  role: "synth_wire",
                  input_stats: {
                    evidence_count: selectedEvidence.length,
                    approx_chars: systemPrompt.length + userPrompt.length,
                  },
                  onAudit: handleAudit,
                },
              });
              wireRawContent = wireRaw.content;
              if (budget?.shouldStopRepo(repoCard.full_name).stop) {
                throw new Error("Budget cutoff during repo synthesis");
              }
              lastWireRaw = wireRawContent;
              roleOutputs[repoCard.full_name].synth = {
                iter,
                selected_evidence: selectedEvidence.length,
                wire_raw: wireRaw.content.slice(0, 2000),
              };
            } else {
              if (!lastWireRaw) {
                throw new Error("bridge_only rerun requested without previous wire output");
              }
              wireRawContent = lastWireRaw;
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            emit({
              node: "llm_spec_generator",
              repo: repoCard.full_name,
              level: "warn",
              event: "GAP_FAIL",
              data: { iter, reason: `synth failed: ${lastError}` },
            });
            if (iter >= maxIters) break;
            const enrichKeywords = extractGapKeywords({
              report: null,
              emptyFields: ["synth", "citations"],
            });
            const enriched = await enrichEvidence({
              repoCard,
              reason: { lastBridgeReport: null, keywords: enrichKeywords, iter },
              config: gapLoop,
              githubToken: process.env.GITHUB_TOKEN,
              emit,
            });
            repoCard = enriched.updatedRepoCard;
            addedEvidenceTotal +=
              enriched.added.readme + enriched.added.issue + enriched.added.release + enriched.added.root_files;
            emit({
              node: "llm_spec_generator",
              repo: repoCard.full_name,
              level: "info",
              event: "GAP_ENRICH_TRIGGER",
              data: { iter, keywords: enrichKeywords, added: enriched.added },
            });
            continue;
          }

          const bridge = await runBridge({
            repo: repoCard.full_name,
            run_id: state.run_id,
            generated_at: state.generated_at,
            source_repo: {
              full_name: repoCard.full_name,
              url: repoCard.html_url,
            },
            topics: repoCard.topics,
            wireRaw: wireRawContent,
            allowedEvidenceIds,
            evidenceLines,
            provider: state.config.llm.provider,
            model: state.config.llm.model,
            temperature: state.config.llm.temperature,
            maxRepairAttempts: Math.min(2, state.config.budget?.maxRepairAttempts ?? 2),
            iter,
            onAudit: handleAudit,
            onEvent: (event, data) => {
              emit({
                node: "llm_spec_generator",
                repo: repoCard.full_name,
                level: event.includes("FAIL") ? "warn" : "info",
                event,
                data: { ...(data ?? {}), iter },
              });
            },
          });

          if (gapLoop.writeReportsEachIter) {
            writeReportArtifact({
              generated_at: state.generated_at,
              repo_full_name: repoCard.full_name,
              report: bridge.report,
              suffix: `iter${iter}`,
            });
          }

          finalBridge = { ...bridge, iter };
          lastBridgeReport = bridge.report;
          if (bridge.ok && bridge.canonical) {
            emit({
              node: "llm_spec_generator",
              repo: repoCard.full_name,
              level: "info",
              event: "GAP_SUCCESS",
              data: { iter, coverage_ratio: bridge.report.final.coverage_ratio ?? 0 },
            });
            break;
          }

          lastError = bridge.report.final.reason ?? "bridge failed";
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "warn",
            event: "GAP_FAIL",
            data: {
              iter,
              reason: lastError,
              coverage_ratio: bridge.report.final.coverage_ratio ?? 0,
            },
          });
          if (iter >= maxIters) {
            break;
          }

          const failureLooksLlmUnstable =
            bridge.report.stages.some(
              (stage) =>
                (stage.name === "wire_validate" || stage.name === "canonical_validate") && !stage.ok,
            ) ||
            ((bridge.report.final.attempts_used ?? 0) >= (state.config.budget?.maxRepairAttempts ?? 2) &&
              (bridge.report.final.unknown_ids_count ?? 0) === 0 &&
              repoCard.evidence.length >= 10);
          if (
            pruning.enabled &&
            pruning.rerunSynthWithoutEnrichOnce &&
            !didRerunSynthWithoutEnrich &&
            failureLooksLlmUnstable
          ) {
            didRerunSynthWithoutEnrich = true;
            emit({
              node: "llm_spec_generator",
              repo: repoCard.full_name,
              level: "info",
              event: "PRUNE_RERUN_SYNTH_WITHOUT_ENRICH",
              data: { iter, reason: "llm_unstable_or_structural_failure" },
            });
            continue;
          }

          const enrichKeywords = extractGapKeywords({
            report: bridge.report,
            emptyFields: [],
          });
          const enriched = await enrichEvidence({
            repoCard,
            reason: { lastBridgeReport: bridge.report, keywords: enrichKeywords, iter },
            config: gapLoop,
            githubToken: process.env.GITHUB_TOKEN,
            emit,
          });
          repoCard = enriched.updatedRepoCard;
          addedEvidenceTotal +=
            enriched.added.readme + enriched.added.issue + enriched.added.release + enriched.added.root_files;
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "info",
            event: "GAP_ENRICH_TRIGGER",
            data: { iter, keywords: enrichKeywords, added: enriched.added },
          });
        }

        evidenceValidated += 1;
        if (!finalBridge || !finalBridge.ok || !finalBridge.canonical) {
          const reportPath = finalBridge
            ? writeReportArtifact({
                generated_at: state.generated_at,
                repo_full_name: repoCard.full_name,
                report: finalBridge.report,
              }).path
            : undefined;
          specsFailed += 1;
          evidenceValidFailed += 1;
          const classified = classifyFailure({
            error: finalBridge?.report.final.reason ?? lastError ?? "bridge failed",
            report: finalBridge?.report ?? null,
            isFetchError: state.gaps.some((gap) => gap.repo === repoCard.full_name),
            gapItersUsed: usedIterations,
            maxGapIters: maxIters,
            evidenceAddedTotal: addedEvidenceTotal,
          });
          failTaxonomySummary[classified.kind] += 1;
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "warn",
            event: "FAIL_CLASSIFIED",
            data: { kind: classified.kind, iter: usedIterations },
          });
          specResults.push({
            repo: repoCard.full_name,
            ok: false,
            error: finalBridge?.report.final.reason ?? lastError ?? "bridge failed",
            fail_kind: classified.kind,
            fail_message: classified.message,
            hints: classified.hints,
          });
          evidenceResults.push({ repo: repoCard.full_name, ok: false, error: "spec not generated" });
          evidenceReports.push({
            repo: repoCard.full_name,
            ok: false,
            missing_evidence_ids: [],
            invalid_structure: reportPath ? [`Bridge failed, see report: ${reportPath}`] : ["Bridge failed"],
            coverage: {
              app: false,
              core_loop: false,
              screens: { total: 0, cited: 0 },
              commands: { total: 0, cited: 0 },
              tables: { total: 0, cited: 0 },
              acceptance_tests: { total: 0, cited: 0 },
              ratio: finalBridge?.report.final.coverage_ratio ?? 0,
            },
            unused_evidence_ids: [],
            notes: [finalBridge?.report.final.reason ?? lastError ?? "bridge failed"],
          });
          perRepoBridge.push({
            repo: repoCard.full_name,
            ok: false,
            coverage_ratio: finalBridge?.report.final.coverage_ratio ?? 0,
            unknown_ids_count: finalBridge?.report.final.unknown_ids_count ?? 0,
            empty_fields_count: finalBridge?.report.final.empty_fields_count ?? 0,
            attempts_used: finalBridge?.report.final.attempts_used ?? 0,
          });
          perRepoGapLoop.push({
            repo: repoCard.full_name,
            attempts_used: usedIterations,
            success: false,
            evidence_total_initial: initialEvidenceTotal,
            evidence_total_final: repoCard.evidence.length,
            evidence_added_total: addedEvidenceTotal,
            last_error: finalBridge?.report.final.reason ?? lastError ?? "bridge failed",
          });
          budget?.finishRepo(repoCard.full_name, { ok: false });
          continue;
        }

        evidenceValidOk += 1;
        perRepoBridge.push({
          repo: repoCard.full_name,
          ok: true,
          coverage_ratio: finalBridge.report.final.coverage_ratio ?? 0,
          unknown_ids_count: finalBridge.report.final.unknown_ids_count ?? 0,
          empty_fields_count: finalBridge.report.final.empty_fields_count ?? 0,
          attempts_used: finalBridge.report.final.attempts_used ?? 0,
        });
        const { path: reportPath } = writeReportArtifact({
          generated_at: state.generated_at,
          repo_full_name: repoCard.full_name,
          report: finalBridge.report,
        });

        const fileName = `${toSafeRepoFileName(repoCard.full_name)}.json`;
        const relativeSpecPath = path.join("specs", dateDir, fileName);
        const absoluteSpecPath = path.resolve(process.cwd(), relativeSpecPath);
        await mkdir(path.dirname(absoluteSpecPath), { recursive: true });
        await writeFile(absoluteSpecPath, `${JSON.stringify(finalBridge.canonical, null, 2)}\n`, "utf-8");
        emit({
          node: "artifacts",
          repo: repoCard.full_name,
          level: "info",
          event: "SPEC_WRITE_OK",
          data: { spec_path: relativeSpecPath, iter: finalBridge.iter },
        });
        updateIndexSpecPath(index, repoCard.full_name, relativeSpecPath);
        specResults.push({ repo: repoCard.full_name, ok: true, spec_path: relativeSpecPath });
        specsSucceeded += 1;

        try {
          const evidenceOut = writeEvidenceArtifact({
            run_id: state.run_id,
            generated_at: state.generated_at,
            repo_full_name: repoCard.full_name,
            repo_url: repoCard.html_url,
            spec_path: relativeSpecPath,
            evidencePack: repoCard.evidence,
          });
          updateIndexEvidencePath(index, repoCard.full_name, evidenceOut.path);
          evidenceResults.push({ repo: repoCard.full_name, ok: true, evidence_path: evidenceOut.path });
          evidenceWritten += 1;
          emit({
            node: "artifacts",
            repo: repoCard.full_name,
            level: "info",
            event: "EVIDENCE_WRITE_OK",
            data: { evidence_path: evidenceOut.path, iter: finalBridge.iter },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          evidenceWriteFailed += 1;
          evidenceResults.push({ repo: repoCard.full_name, ok: false, error: message });
          emit({
            node: "artifacts",
            repo: repoCard.full_name,
            level: "warn",
            event: "EVIDENCE_WRITE_FAIL",
            data: { error: message, iter: finalBridge.iter },
          });
        }

        evidenceReports.push({
          repo: repoCard.full_name,
          ok: true,
          missing_evidence_ids: [],
          invalid_structure: [],
          coverage: {
            app: true,
            core_loop: true,
            screens: { total: finalBridge.canonical.screens.length, cited: finalBridge.canonical.screens.length },
            commands: {
              total: finalBridge.canonical.rust_commands.length,
              cited: finalBridge.canonical.rust_commands.length,
            },
            tables: {
              total: finalBridge.canonical.data_model.tables.length,
              cited: finalBridge.canonical.data_model.tables.length,
            },
            acceptance_tests: {
              total: finalBridge.canonical.acceptance_tests.length,
              cited: finalBridge.canonical.acceptance_tests.length,
            },
            ratio: finalBridge.report.final.coverage_ratio ?? 1,
          },
          unused_evidence_ids: [],
          notes: [`bridge report: ${reportPath}`],
        });
        perRepoGapLoop.push({
          repo: repoCard.full_name,
          attempts_used: usedIterations,
          success: true,
          evidence_total_initial: initialEvidenceTotal,
          evidence_total_final: repoCard.evidence.length,
          evidence_added_total: addedEvidenceTotal,
          last_error: null,
        });
        logs.push(
          `[llm_spec_generator] ${repoCard.full_name} canonical spec ok (iter=${usedIterations}) -> ${relativeSpecPath}`,
        );
        budget?.finishRepo(repoCard.full_name, { ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const classified = classifyFailure({
            error: message,
            isFetchError: state.gaps.some((gap) => gap.repo === repoCard.full_name),
          });
          failTaxonomySummary[classified.kind] += 1;
          emit({
            node: "llm_spec_generator",
            repo: repoCard.full_name,
            level: "warn",
            event: "FAIL_CLASSIFIED",
            data: { kind: classified.kind },
          });
          specsFailed += 1;
          evidenceValidated += 1;
          evidenceValidFailed += 1;
          specResults.push({
            repo: repoCard.full_name,
            ok: false,
            error: message,
            fail_kind: classified.kind,
            fail_message: classified.message,
            hints: classified.hints,
          });
          evidenceResults.push({ repo: repoCard.full_name, ok: false, error: "spec not generated" });
          perRepoGapLoop.push({
            repo: repoCard.full_name,
            attempts_used: usedIterations,
            success: false,
            evidence_total_initial: initialEvidenceTotal,
            evidence_total_final: repoCard.evidence.length,
            evidence_added_total: addedEvidenceTotal,
            last_error: message,
          });
          budget?.finishRepo(repoCard.full_name, { ok: false });
          logs.push(`[llm_spec_generator] ${repoCard.full_name} failed: ${message}`);
        }
      }

      if (specsSucceeded > 0) {
        saveIndex(index);
      }

      return {
        ...state,
        index,
        role_outputs: roleOutputs,
        spec_results: specResults,
        evidence_results: evidenceResults,
        evidence_reports: evidenceReports,
        llm_audits: llmAudits,
        per_repo_bridge: perRepoBridge,
        per_repo_gap_loop: perRepoGapLoop,
        fail_taxonomy_summary: failTaxonomySummary,
        stats: {
          ...state.stats,
          specs_attempted: state.repo_cards.length,
          specs_succeeded: specsSucceeded,
          specs_failed: specsFailed,
          evidence_validated: evidenceValidated,
          evidence_valid_ok: evidenceValidOk,
          evidence_valid_failed: evidenceValidFailed,
          evidence_written: evidenceWritten,
          evidence_write_failed: evidenceWriteFailed,
        },
        logs,
        status: "ok",
      };
    })
    .addEdge(START, "bootstrap")
    .addEdge("bootstrap", "repo_finder")
    .addEdge("repo_finder", "deduper")
    .addEdge("deduper", "repo_card_builder")
    .addEdge("repo_card_builder", "llm_spec_generator")
    .addEdge("llm_spec_generator", END)
    .compile();
}
