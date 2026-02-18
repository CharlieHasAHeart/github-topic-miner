import type { createLogger } from "./logger";

type MinerLogger = ReturnType<typeof createLogger>;

export interface BudgetConfig {
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
}

export interface BudgetState {
  runStartMs: number;
  llmCallsTotal: number;
  llmCallsPerRepo: Record<string, number>;
  tokensApproxTotal: number;
  tokensApproxPerRepo: Record<string, number>;
  reposProcessed: number;
  stopReason?: string | null;
}

function tokensApprox(promptChars: number, completionChars: number): number {
  return Math.ceil((promptChars + completionChars) / 4);
}

export function createBudgetManager(
  configBudget: BudgetConfig,
  logger: MinerLogger | undefined,
  runId: string,
): {
  beginRepo: (repoFullName: string) => void;
  recordLlmCall: (
    repoFullName: string,
    promptChars: number,
    completionChars: number,
    meta?: { role?: string; iter?: number; repairAttempt?: number },
  ) => void;
  shouldStopRun: () => { stop: boolean; reason?: string };
  shouldStopRepo: (repoFullName: string) => { stop: boolean; reason?: string };
  finishRepo: (repoFullName: string, result: { ok: boolean }) => void;
  snapshot: () => BudgetState;
} {
  const state: BudgetState = {
    runStartMs: Date.now(),
    llmCallsTotal: 0,
    llmCallsPerRepo: {},
    tokensApproxTotal: 0,
    tokensApproxPerRepo: {},
    reposProcessed: 0,
    stopReason: null,
  };

  const emitStopRun = (reason: string) => {
    if (!state.stopReason) {
      state.stopReason = reason;
      logger?.log({
        node: "bootstrap",
        level: "warn",
        event: "BUDGET_STOP_RUN",
        data: { reason, snapshot: state, run_id: runId },
      });
    }
  };

  const emitStopRepo = (repo: string, reason: string) => {
    logger?.log({
      node: "llm_spec_generator",
      repo,
      level: "warn",
      event: "BUDGET_STOP_REPO",
      data: { reason, snapshot: state },
    });
  };

  const shouldStopRun = (): { stop: boolean; reason?: string } => {
    if (!configBudget.enabled) return { stop: false };
    if (state.reposProcessed >= configBudget.maxReposPerRun) {
      const reason = "maxReposPerRun reached";
      emitStopRun(reason);
      return { stop: true, reason };
    }
    if (Date.now() - state.runStartMs > configBudget.maxWallTimeSeconds * 1000) {
      const reason = "maxWallTimeSeconds exceeded";
      emitStopRun(reason);
      return { stop: true, reason };
    }
    if (state.llmCallsTotal >= configBudget.maxTotalLlmCallsPerRun) {
      const reason = "maxTotalLlmCallsPerRun reached";
      emitStopRun(reason);
      return { stop: true, reason };
    }
    if (state.tokensApproxTotal >= configBudget.maxTotalTokensApproxPerRun) {
      const reason = "maxTotalTokensApproxPerRun reached";
      emitStopRun(reason);
      return { stop: true, reason };
    }
    return { stop: false };
  };

  const shouldStopRepo = (repoFullName: string): { stop: boolean; reason?: string } => {
    if (!configBudget.enabled) return { stop: false };
    const calls = state.llmCallsPerRepo[repoFullName] ?? 0;
    if (calls >= configBudget.maxLlmCallsPerRepo) {
      const reason = "maxLlmCallsPerRepo reached";
      emitStopRepo(repoFullName, reason);
      return { stop: true, reason };
    }
    return { stop: false };
  };

  return {
    beginRepo(repoFullName) {
      if (!(repoFullName in state.llmCallsPerRepo)) state.llmCallsPerRepo[repoFullName] = 0;
      if (!(repoFullName in state.tokensApproxPerRepo)) state.tokensApproxPerRepo[repoFullName] = 0;
    },
    recordLlmCall(repoFullName, promptChars, completionChars, meta) {
      const t = tokensApprox(promptChars, completionChars);
      state.llmCallsTotal += 1;
      state.llmCallsPerRepo[repoFullName] = (state.llmCallsPerRepo[repoFullName] ?? 0) + 1;
      state.tokensApproxTotal += t;
      state.tokensApproxPerRepo[repoFullName] = (state.tokensApproxPerRepo[repoFullName] ?? 0) + t;
      logger?.log({
        node: "llm_spec_generator",
        repo: repoFullName,
        level: "info",
        event: "BUDGET_LLM_CALL_RECORDED",
        data: { promptChars, completionChars, tokensApprox: t, ...meta },
      });
    },
    shouldStopRun,
    shouldStopRepo,
    finishRepo(_repoFullName, _result) {
      state.reposProcessed += 1;
    },
    snapshot() {
      return {
        ...state,
        llmCallsPerRepo: { ...state.llmCallsPerRepo },
        tokensApproxPerRepo: { ...state.tokensApproxPerRepo },
      };
    },
  };
}
