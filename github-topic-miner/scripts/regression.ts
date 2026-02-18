import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FailKind } from "./types";

export interface RegressionConfig {
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
}

export interface RegressionResult {
  suiteName: string;
  run_id: string;
  generated_at: string;
  repos: Array<{
    repo: string;
    ok: boolean;
    specs_written: boolean;
    evidence_written: boolean;
    attempts_used: number;
    gap_iters_used: number;
    llm_calls: number;
    fail_kind?: FailKind;
  }>;
  summary: {
    total: number;
    succeeded: number;
    avg_attempts_used: number;
    avg_gap_iters: number;
    fail_kinds: Record<string, number>;
  };
  thresholds: RegressionConfig["thresholds"];
  pass: boolean;
}

export async function runRegressionSuite(params: {
  config: RegressionConfig;
  run_id: string;
  generated_at: string;
  runOneRepo: (fullName: string) => Promise<RegressionResult["repos"][number]>;
}): Promise<{ result: RegressionResult; outputPath: string; latestPath: string }> {
  const repos: RegressionResult["repos"] = [];
  for (const repo of params.config.repos) {
    repos.push(await params.runOneRepo(repo));
  }
  const total = repos.length;
  const succeeded = repos.filter((r) => r.ok).length;
  const avgAttempts = total > 0 ? repos.reduce((a, b) => a + b.attempts_used, 0) / total : 0;
  const avgGapIters = total > 0 ? repos.reduce((a, b) => a + b.gap_iters_used, 0) / total : 0;
  const failKinds: Record<string, number> = {};
  for (const repo of repos) {
    if (repo.fail_kind) failKinds[repo.fail_kind] = (failKinds[repo.fail_kind] ?? 0) + 1;
  }

  let pass = true;
  if (params.config.failOnRegressionDrop) {
    if (succeeded < params.config.thresholds.minSpecsSucceeded) pass = false;
    if (avgAttempts > params.config.thresholds.maxAvgAttemptsUsed) pass = false;
    if (avgGapIters > params.config.thresholds.maxAvgGapIters) pass = false;
  }

  const result: RegressionResult = {
    suiteName: params.config.suiteName,
    run_id: params.run_id,
    generated_at: params.generated_at,
    repos,
    summary: {
      total,
      succeeded,
      avg_attempts_used: Number(avgAttempts.toFixed(4)),
      avg_gap_iters: Number(avgGapIters.toFixed(4)),
      fail_kinds: failKinds,
    },
    thresholds: params.config.thresholds,
    pass,
  };

  const dateDir = params.generated_at.slice(0, 10);
  const outDir = path.resolve(
    process.cwd(),
    params.config.outputDir,
    params.config.suiteName,
    dateDir,
  );
  mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `${params.run_id}.json`);
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

  const latestDir = path.resolve(process.cwd(), params.config.outputDir, params.config.suiteName);
  mkdirSync(latestDir, { recursive: true });
  const latestPath = path.join(latestDir, "latest.json");
  writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

  return { result, outputPath, latestPath };
}
