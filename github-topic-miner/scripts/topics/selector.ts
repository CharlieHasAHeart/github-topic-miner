import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MinerConfig } from "../types";

type TopicLayer = "core" | "adjacent" | "explore";

interface SeedPool {
  generated_at: string;
  strategy?: {
    core_topics?: string[];
  };
  topics: string[];
}

interface TopicStat {
  zero_new_streak: number;
  success_runs: number;
  last_seen_run_seq: number;
  frozen_until_run_seq?: number;
}

interface TopicSelectionState {
  version: 1;
  updated_at: string;
  run_seq: number;
  cursor: Record<TopicLayer, number>;
  recent_runs: Array<{ run_id: string; run_seq: number; topics: string[] }>;
  topic_stats: Record<string, TopicStat>;
}

interface TopicSelectionConfigResolved {
  enabled: boolean;
  sourcePath: string;
  statePath: string;
  batchSize: number;
  coreRatio: number;
  adjacentRatio: number;
  exploreRatio: number;
  cooldownRuns: number;
  lowYieldFreezeThreshold: number;
  lowYieldFreezeRuns: number;
}

export interface TopicSelectionResult {
  topics: string[];
  summary: {
    enabled: boolean;
    batch_size: number;
    quotas: Record<TopicLayer, number>;
    source_path: string;
    state_path: string;
    skipped_by_cooldown: number;
    skipped_by_freeze: number;
  };
}

const DEFAULT_SOURCE_PATH = path.join(
  "github-topic-miner",
  "config",
  "topics",
  "seed_pool.json",
);
const DEFAULT_STATE_PATH = path.join("specs", "topic_selection_state.json");

const ADJACENT_TOPICS = new Set<string>([
  "openapi",
  "graphql",
  "rest-api",
  "api",
  "orm",
  "integration-testing",
  "unit-testing",
  "vite",
  "webapp",
  "egui",
  "iced",
  "wails",
  "rocket",
  "fastapi",
  "supabase",
  "postgresql",
  "mysql",
  "mariadb",
  "redis",
  "mongodb",
  "github-api",
  "sqlite",
]);

function resolveTopicSelectionConfig(config: MinerConfig): TopicSelectionConfigResolved {
  return {
    enabled: config.topicSelection?.enabled ?? true,
    sourcePath: config.topicSelection?.sourcePath ?? DEFAULT_SOURCE_PATH,
    statePath: config.topicSelection?.statePath ?? DEFAULT_STATE_PATH,
    batchSize: config.topicSelection?.batchSize ?? 10,
    coreRatio: config.topicSelection?.coreRatio ?? 0.5,
    adjacentRatio: config.topicSelection?.adjacentRatio ?? 0.3,
    exploreRatio: config.topicSelection?.exploreRatio ?? 0.2,
    cooldownRuns: config.topicSelection?.cooldownRuns ?? 3,
    lowYieldFreezeThreshold: config.topicSelection?.lowYieldFreezeThreshold ?? 3,
    lowYieldFreezeRuns: config.topicSelection?.lowYieldFreezeRuns ?? 3,
  };
}

function loadSeedPool(sourcePath: string): SeedPool | null {
  const absPath = path.resolve(process.cwd(), sourcePath);
  try {
    const raw = readFileSync(absPath, "utf8");
    return JSON.parse(raw) as SeedPool;
  } catch {
    return null;
  }
}

function emptyState(): TopicSelectionState {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    run_seq: 0,
    cursor: { core: 0, adjacent: 0, explore: 0 },
    recent_runs: [],
    topic_stats: {},
  };
}

function loadState(statePath: string): TopicSelectionState {
  const absPath = path.resolve(process.cwd(), statePath);
  try {
    const raw = readFileSync(absPath, "utf8");
    const parsed = JSON.parse(raw) as TopicSelectionState;
    if (parsed.version === 1) return parsed;
    return emptyState();
  } catch {
    return emptyState();
  }
}

function saveState(statePath: string, state: TopicSelectionState): void {
  const absPath = path.resolve(process.cwd(), statePath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function classifyTopic(topic: string, coreSet: Set<string>): TopicLayer {
  if (coreSet.has(topic)) return "core";
  if (ADJACENT_TOPICS.has(topic)) return "adjacent";
  return "explore";
}

function computeQuotas(
  batchSize: number,
  coreRatio: number,
  adjacentRatio: number,
  exploreRatio: number,
): Record<TopicLayer, number> {
  const norm = coreRatio + adjacentRatio + exploreRatio || 1;
  const core = Math.max(0, Math.floor((batchSize * coreRatio) / norm));
  const adjacent = Math.max(0, Math.floor((batchSize * adjacentRatio) / norm));
  const explore = Math.max(0, batchSize - core - adjacent);
  return { core, adjacent, explore };
}

function pickWithCursor(
  list: string[],
  need: number,
  cursor: number,
  blocked: Set<string>,
): { picked: string[]; cursor: number; blockedHits: number } {
  if (list.length === 0 || need <= 0) {
    return { picked: [], cursor, blockedHits: 0 };
  }
  const picked: string[] = [];
  let idx = cursor % list.length;
  let scanned = 0;
  let blockedHits = 0;
  while (picked.length < need && scanned < list.length * 2) {
    const topic = list[idx];
    if (!blocked.has(topic) && !picked.includes(topic)) {
      picked.push(topic);
    } else {
      blockedHits += 1;
    }
    idx = (idx + 1) % list.length;
    scanned += 1;
  }
  return { picked, cursor: idx, blockedHits };
}

export function selectTopicsForRun(
  config: MinerConfig,
  runId: string,
): { topics: string[]; summary: TopicSelectionResult["summary"] } {
  const cfg = resolveTopicSelectionConfig(config);
  if (!cfg.enabled) {
    return {
      topics: config.topics,
      summary: {
        enabled: false,
        batch_size: config.topics.length,
        quotas: { core: config.topics.length, adjacent: 0, explore: 0 },
        source_path: cfg.sourcePath,
        state_path: cfg.statePath,
        skipped_by_cooldown: 0,
        skipped_by_freeze: 0,
      },
    };
  }

  const seed = loadSeedPool(cfg.sourcePath);
  if (!seed || !Array.isArray(seed.topics) || seed.topics.length === 0) {
    return {
      topics: config.topics,
      summary: {
        enabled: false,
        batch_size: config.topics.length,
        quotas: { core: config.topics.length, adjacent: 0, explore: 0 },
        source_path: cfg.sourcePath,
        state_path: cfg.statePath,
        skipped_by_cooldown: 0,
        skipped_by_freeze: 0,
      },
    };
  }

  const state = loadState(cfg.statePath);
  const coreSet = new Set((seed.strategy?.core_topics ?? []).map((t) => t.toLowerCase()));
  const layered: Record<TopicLayer, string[]> = { core: [], adjacent: [], explore: [] };
  for (const topic of seed.topics.map((t) => t.toLowerCase())) {
    layered[classifyTopic(topic, coreSet)].push(topic);
  }

  const cooldownSet = new Set<string>();
  for (const run of state.recent_runs.slice(-cfg.cooldownRuns)) {
    for (const topic of run.topics) cooldownSet.add(topic);
  }

  const freezeSet = new Set<string>();
  for (const [topic, stat] of Object.entries(state.topic_stats)) {
    if ((stat.frozen_until_run_seq ?? 0) > state.run_seq) freezeSet.add(topic);
  }
  const blocked = new Set([...cooldownSet, ...freezeSet]);
  const quotas = computeQuotas(
    Math.max(1, cfg.batchSize),
    cfg.coreRatio,
    cfg.adjacentRatio,
    cfg.exploreRatio,
  );

  const corePick = pickWithCursor(layered.core, quotas.core, state.cursor.core, blocked);
  const adjacentPick = pickWithCursor(
    layered.adjacent,
    quotas.adjacent,
    state.cursor.adjacent,
    blocked,
  );
  const explorePick = pickWithCursor(
    layered.explore,
    quotas.explore,
    state.cursor.explore,
    blocked,
  );

  let selected = [...corePick.picked, ...adjacentPick.picked, ...explorePick.picked];
  if (selected.length < cfg.batchSize) {
    const all = [...layered.core, ...layered.adjacent, ...layered.explore];
    for (const topic of all) {
      if (selected.length >= cfg.batchSize) break;
      if (!selected.includes(topic)) selected.push(topic);
    }
  }

  selected = selected.slice(0, cfg.batchSize);

  const nextState: TopicSelectionState = {
    ...state,
    updated_at: new Date().toISOString(),
    run_seq: state.run_seq + 1,
    cursor: {
      core: corePick.cursor,
      adjacent: adjacentPick.cursor,
      explore: explorePick.cursor,
    },
    recent_runs: [
      ...state.recent_runs.slice(-19),
      { run_id: runId, run_seq: state.run_seq + 1, topics: selected },
    ],
  };
  saveState(cfg.statePath, nextState);

  return {
    topics: selected,
    summary: {
      enabled: true,
      batch_size: cfg.batchSize,
      quotas,
      source_path: cfg.sourcePath,
      state_path: cfg.statePath,
      skipped_by_cooldown: corePick.blockedHits + adjacentPick.blockedHits + explorePick.blockedHits,
      skipped_by_freeze: freezeSet.size,
    },
  };
}

export function finalizeTopicSelectionRun(
  config: MinerConfig,
  runId: string,
  topicResultCounts: Record<string, number>,
): void {
  const cfg = resolveTopicSelectionConfig(config);
  if (!cfg.enabled) return;
  const state = loadState(cfg.statePath);
  const run = state.recent_runs.find((r) => r.run_id === runId);
  if (!run) return;

  for (const topic of run.topics) {
    const resultCount = topicResultCounts[topic] ?? 0;
    const prev = state.topic_stats[topic] ?? {
      zero_new_streak: 0,
      success_runs: 0,
      last_seen_run_seq: state.run_seq,
    };
    const next: TopicStat = {
      ...prev,
      last_seen_run_seq: state.run_seq,
      zero_new_streak: resultCount <= 0 ? prev.zero_new_streak + 1 : 0,
      success_runs: resultCount > 0 ? prev.success_runs + 1 : prev.success_runs,
      frozen_until_run_seq: prev.frozen_until_run_seq,
    };
    if (next.zero_new_streak >= cfg.lowYieldFreezeThreshold) {
      next.frozen_until_run_seq = state.run_seq + cfg.lowYieldFreezeRuns;
      next.zero_new_streak = 0;
    }
    state.topic_stats[topic] = next;
  }
  state.updated_at = new Date().toISOString();
  saveState(cfg.statePath, state);
}
