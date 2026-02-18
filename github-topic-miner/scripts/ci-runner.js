#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "github-topic-miner", "config", "miner.config.json");
const DIST_RUN_PATH = path.join(ROOT, "dist", "github-topic-miner", "scripts", "run.js");

function parseBool(value) {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function latestRunFile() {
  const runsDir = path.join(ROOT, "runs");
  if (!fs.existsSync(runsDir)) return null;
  const files = fs
    .readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(runsDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  return path.join("runs", files[0].name);
}

function writeGithubOutput(key, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
}

function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(DIST_RUN_PATH)) {
    console.error(`Build output not found: ${DIST_RUN_PATH}. Run npm run build first.`);
    process.exit(1);
  }

  const topic = process.env.TOPIC ? String(process.env.TOPIC).trim() : "";
  const maxReposRaw = process.env.MAX_REPOS_PER_RUN;
  const maxRepos = maxReposRaw ? Number(maxReposRaw) : NaN;
  const dryRun = parseBool(process.env.DRY_RUN || "");
  const minSpecsSucceededRaw = process.env.MIN_SPECS_SUCCEEDED;
  const minSpecsSucceeded = Number.isFinite(Number(minSpecsSucceededRaw))
    ? Math.max(0, Number(minSpecsSucceededRaw))
    : 1;

  const originalConfigRaw = fs.readFileSync(CONFIG_PATH, "utf8");
  const config = JSON.parse(originalConfigRaw);

  if (topic) {
    config.topics = [topic];
  }
  if (Number.isFinite(maxRepos) && maxRepos > 0) {
    config.maxNewReposPerRun = maxRepos;
    config.budget = config.budget || {};
    config.budget.maxReposPerRun = maxRepos;
  }

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const startedAt = Date.now();
  const result = spawnSync("node", [DIST_RUN_PATH], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  fs.writeFileSync(CONFIG_PATH, originalConfigRaw, "utf8");

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  let runPath = null;
  const stdout = result.stdout || "";
  const match = stdout.match(/Run written:\s*(runs\/[^\s]+\.json)/);
  if (match) {
    runPath = match[1];
  } else {
    const latest = latestRunFile();
    if (latest) runPath = latest;
  }

  let runId = "";
  if (runPath) {
    runId = path.basename(runPath, ".json");
    console.log(`CI_RUN_ID=${runId}`);
    console.log(`CI_RUN_PATH=${runPath}`);
    writeGithubOutput("run_id", runId);
    writeGithubOutput("run_path", runPath);
  } else {
    writeGithubOutput("run_id", "");
    writeGithubOutput("run_path", "");
  }
  writeGithubOutput("dry_run", dryRun ? "true" : "false");
  writeGithubOutput("duration_ms", String(Date.now() - startedAt));

  if (result.status !== 0) {
    process.exit(1);
  }

  if (runPath) {
    const absRunPath = path.join(ROOT, runPath);
    if (fs.existsSync(absRunPath)) {
      const payload = JSON.parse(fs.readFileSync(absRunPath, "utf8"));
      const status = payload?.status;
      const attempted = Number(payload?.stats?.specs_attempted ?? 0);
      const succeeded = Number(payload?.stats?.specs_succeeded ?? 0);
      console.log(`CI_SPECS_ATTEMPTED=${attempted}`);
      console.log(`CI_SPECS_SUCCEEDED=${succeeded}`);
      writeGithubOutput("specs_attempted", String(attempted));
      writeGithubOutput("specs_succeeded", String(succeeded));

      if (status !== "ok") {
        console.error(`CI check failed: run status is ${status}`);
        process.exit(1);
      }
      if (attempted > 0 && succeeded < minSpecsSucceeded) {
        console.error(
          `CI check failed: specs_succeeded (${succeeded}) < MIN_SPECS_SUCCEEDED (${minSpecsSucceeded}) with attempted=${attempted}`,
        );
        process.exit(1);
      }
    }
  }
}

main();
