import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface CandidateTopic {
  name: string;
  short_description: string | null;
  related: string[];
  score: number;
  reasons: string[];
}

const TOPICS_DIR = path.resolve(process.cwd(), "github-topic-miner", "config", "topics");
const CANDIDATE_PATH = path.join(TOPICS_DIR, "candidate_pool.json");
const OUTPUT_PATH = path.join(TOPICS_DIR, "seed_pool.json");

const CORE_TOPICS = [
  "tauri",
  "svelte",
  "rust",
  "sqlite",
  "desktop",
  "cli",
  "database",
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
];

const DENY_KEYWORDS = [
  "twitter",
  "tiktok",
  "spotify",
  "apple-music",
  "pixiv",
  "myanimelist",
  "sports",
  "nashville",
  "climate",
  "game",
  "phaser",
  "openal",
  "opengl",
  "steam",
  "fabricmc",
  "quiltmc",
  "discord",
  "twitch",
  "mobile",
  "bluesky",
];

const BOOST_KEYWORDS = [
  "tauri",
  "rust",
  "sqlite",
  "database",
  "desktop",
  "api",
  "command",
  "tooling",
  "openapi",
  "graphql",
  "testing",
  "orm",
  "svelte",
];

function containsAny(text: string, keys: string[]): boolean {
  return keys.some((k) => text.includes(k));
}

function rankTopic(topic: CandidateTopic): number {
  const text = `${topic.name} ${topic.short_description ?? ""} ${topic.related.join(" ")} ${topic.reasons.join(" ")}`.toLowerCase();
  let rank = topic.score;
  if (containsAny(text, BOOST_KEYWORDS)) rank += 2;
  if (topic.name.length <= 20) rank += 1;
  return rank;
}

export function generateSeedPool() {
  const raw = readFileSync(CANDIDATE_PATH, "utf8");
  const parsed = JSON.parse(raw) as { topics: CandidateTopic[] };
  const byName = new Map<string, CandidateTopic>();
  for (const topic of parsed.topics) byName.set(topic.name, topic);

  const selected = new Set<string>();
  for (const t of CORE_TOPICS) {
    if (byName.has(t)) selected.add(t);
  }

  const extra = parsed.topics
    .filter((t) => !selected.has(t.name))
    .filter((t) => t.score >= 4)
    .filter((t) => !containsAny(t.name.toLowerCase(), DENY_KEYWORDS))
    .sort((a, b) => rankTopic(b) - rankTopic(a) || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((t) => t.name);
  for (const t of extra) selected.add(t);

  const topics = [...selected].sort((a, b) => a.localeCompare(b));
  mkdirSync(TOPICS_DIR, { recursive: true });
  writeFileSync(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source: "candidate_pool.json",
        strategy: {
          core_topics: CORE_TOPICS,
          min_score: 4,
          deny_keywords: DENY_KEYWORDS,
          extra_take: 20,
        },
        topics,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`seed_pool: ${OUTPUT_PATH}`);
  console.log(`seed_topics: ${topics.length}`);
}

if (require.main === module) {
  generateSeedPool();
}
