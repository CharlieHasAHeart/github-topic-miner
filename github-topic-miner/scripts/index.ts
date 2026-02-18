import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MinerIndex } from "./types";

export const INDEX_PATH = path.resolve(process.cwd(), "specs", "index.json");

function nowISO(): string {
  return new Date().toISOString();
}

function createEmptyIndex(): MinerIndex {
  return {
    version: 1,
    updated_at: nowISO(),
    repos: {},
  };
}

export function loadIndex(): MinerIndex {
  if (!existsSync(INDEX_PATH)) {
    return createEmptyIndex();
  }

  const raw = readFileSync(INDEX_PATH, "utf-8");
  const parsed = JSON.parse(raw) as MinerIndex;

  if (parsed.version !== 1 || typeof parsed.repos !== "object" || parsed.repos === null) {
    throw new Error(`Invalid index format at ${INDEX_PATH}`);
  }

  return parsed;
}

export function saveIndex(index: MinerIndex): void {
  index.updated_at = nowISO();
  mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

export function updateIndexSeen(
  index: MinerIndex,
  repoFullName: string,
  pushedAt: string,
  runId: string,
): MinerIndex {
  const current = index.repos[repoFullName];
  index.repos[repoFullName] = {
    ...current,
    last_seen_at: nowISO(),
    last_pushed_at: pushedAt,
    last_run_id: runId,
  };
  return index;
}

export function updateIndexSpecPath(
  index: MinerIndex,
  repoFullName: string,
  specPath: string,
): MinerIndex {
  const current = index.repos[repoFullName];
  index.repos[repoFullName] = {
    ...current,
    last_spec_path: specPath,
  };
  return index;
}

export function updateIndexEvidencePath(
  index: MinerIndex,
  repoFullName: string,
  evidencePath: string,
): MinerIndex {
  const current = index.repos[repoFullName];
  index.repos[repoFullName] = {
    ...current,
    evidence_path: evidencePath,
  };
  return index;
}
