import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

interface ExploreTreeItem {
  path: string;
  type: string;
}

interface TopicMeta {
  name: string;
  aliases: string[];
  short_description: string | null;
  related: string[];
  created_by: string | null;
  source_path: string;
}

interface CandidateTopic extends TopicMeta {
  score: number;
  reasons: string[];
}

const OUTPUT_DIR = path.resolve(process.cwd(), "github-topic-miner", "config", "topics");
const RAW_PATH = path.join(OUTPUT_DIR, "raw_pool.json");
const CANDIDATE_PATH = path.join(OUTPUT_DIR, "candidate_pool.json");
const ACTIVE_PATH = path.join(OUTPUT_DIR, "active_pool.json");

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "github-topic-miner",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "github-topic-miner" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return await res.text();
}

function parseFrontMatter(md: string): Record<string, unknown> {
  const trimmed = md.trimStart();
  if (!trimmed.startsWith("---")) return {};
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) return {};
  const yaml = trimmed.slice(4, end).trim();
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (line.trimStart().startsWith("- ") && currentArrayKey) {
      const value = line.trimStart().slice(2).trim().replace(/^['"]|['"]$/g, "");
      const arr = (out[currentArrayKey] as string[]) ?? [];
      arr.push(value);
      out[currentArrayKey] = arr;
      continue;
    }

    currentArrayKey = null;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();

    if (!rawValue) {
      out[key] = [];
      currentArrayKey = key;
      continue;
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const values = rawValue
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      out[key] = values;
      continue;
    }
    if (rawValue === "null") {
      out[key] = null;
      continue;
    }
    out[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }

  return out;
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function scoreTopic(topic: TopicMeta): CandidateTopic {
  const text = `${topic.name} ${topic.short_description ?? ""} ${topic.related.join(" ")}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const stackWords = ["rust", "tauri", "svelte", "sqlite", "database", "cli", "api", "desktop"];
  for (const w of stackWords) {
    if (text.includes(w)) {
      score += 2;
      reasons.push(`match:${w}`);
    }
  }
  if (topic.related.length >= 2) {
    score += 1;
    reasons.push("has_related_topics");
  }
  if (topic.aliases.length > 0) {
    score += 1;
    reasons.push("has_aliases");
  }
  if (topic.name.length >= 3 && topic.name.length <= 30) {
    score += 1;
    reasons.push("name_length_ok");
  }

  return { ...topic, score, reasons };
}

function normalizeTopic(meta: Record<string, unknown>, sourcePath: string): TopicMeta | null {
  const nameRaw = meta.topic ?? meta.title ?? meta.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim().toLowerCase() : "";
  if (!name) return null;

  return {
    name,
    aliases: toArray(meta.aliases).map((x) => x.toLowerCase()),
    short_description:
      typeof meta.short_description === "string" ? meta.short_description.trim() : null,
    related: toArray(meta.related).map((x) => x.toLowerCase()),
    created_by: typeof meta.created_by === "string" ? meta.created_by : null,
    source_path: sourcePath,
  };
}

export async function buildInitialPool() {
  const tree = await fetchJson<{ tree: ExploreTreeItem[] }>(
    "https://api.github.com/repos/github/explore/git/trees/main?recursive=1",
  );
  const topicPaths = tree.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        ((item.path.startsWith("topics/") && item.path.endsWith("/index.md")) ||
          (item.path.startsWith("_topics/") && item.path.endsWith(".md"))),
    )
    .map((item) => item.path);

  const metas: TopicMeta[] = [];
  for (const p of topicPaths) {
    const rawUrl = `https://raw.githubusercontent.com/github/explore/main/${p}`;
    try {
      const md = await fetchText(rawUrl);
      const meta = parseFrontMatter(md);
      const normalized = normalizeTopic(meta, p);
      if (normalized) metas.push(normalized);
    } catch {
      // ignore single file failure
    }
  }

  const dedup = new Map<string, TopicMeta>();
  for (const m of metas) {
    if (!dedup.has(m.name)) dedup.set(m.name, m);
  }

  const rawPool = [...dedup.values()].sort((a, b) => a.name.localeCompare(b.name));
  const candidatePool = rawPool.map(scoreTopic).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const activePool = candidatePool.filter((x) => x.score >= 3).map((x) => x.name);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    RAW_PATH,
    `${JSON.stringify({ source: "github/explore", generated_at: new Date().toISOString(), topics: rawPool }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    CANDIDATE_PATH,
    `${JSON.stringify({ generated_at: new Date().toISOString(), topics: candidatePool }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    ACTIVE_PATH,
    `${JSON.stringify({ generated_at: new Date().toISOString(), topics: activePool }, null, 2)}\n`,
    "utf8",
  );

  console.log(`raw_pool: ${RAW_PATH}`);
  console.log(`candidate_pool: ${CANDIDATE_PATH}`);
  console.log(`active_pool: ${ACTIVE_PATH}`);
  console.log(`topics: raw=${rawPool.length}, candidate=${candidatePool.length}, active=${activePool.length}`);
}

if (require.main === module) {
  void buildInitialPool();
}
