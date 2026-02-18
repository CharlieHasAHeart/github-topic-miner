import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvidenceItem } from "./types";

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function writeJsonPretty(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function buildDatedDirName(generatedAt: string): string {
  return generatedAt.slice(0, 10);
}

export function toSafeRepoFileName(fullName: string): string {
  return fullName.replace(/\//g, "__").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

interface WriteEvidenceArtifactParams {
  run_id: string;
  generated_at: string;
  repo_full_name: string;
  repo_url: string;
  spec_path: string;
  evidencePack: EvidenceItem[];
}

export function writeEvidenceArtifact(params: WriteEvidenceArtifactParams): { path: string } {
  const dateDir = buildDatedDirName(params.generated_at);
  const fileName = `${toSafeRepoFileName(params.repo_full_name)}.json`;
  const relativePath = path.join("evidence", dateDir, fileName);
  const absolutePath = path.resolve(process.cwd(), relativePath);

  ensureDir(path.dirname(absolutePath));
  writeJsonPretty(absolutePath, {
    meta: {
      evidence_version: 1,
      run_id: params.run_id,
      generated_at: params.generated_at,
      source_repo: {
        full_name: params.repo_full_name,
        url: params.repo_url,
      },
      spec_path: params.spec_path,
    },
    evidence: params.evidencePack,
  });

  return { path: relativePath };
}

interface WriteReportArtifactParams {
  generated_at: string;
  repo_full_name: string;
  report: unknown;
  suffix?: string;
}

export function writeReportArtifact(params: WriteReportArtifactParams): { path: string } {
  const dateDir = buildDatedDirName(params.generated_at);
  const fileName = `${toSafeRepoFileName(params.repo_full_name)}${params.suffix ? `__${params.suffix}` : ""}.json`;
  const relativePath = path.join("reports", dateDir, fileName);
  const absolutePath = path.resolve(process.cwd(), relativePath);
  ensureDir(path.dirname(absolutePath));
  writeJsonPretty(absolutePath, params.report);
  return { path: relativePath };
}
