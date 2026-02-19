# GitHub Topic Miner (LangGraph TS) - Part 4 LLM Multi-role

## Local Run

```bash
npm install
# edit .env
npm run miner:dev
```

`GITHUB_TOKEN` is recommended for higher GitHub rate limits. A provider API key is required for Part 4 spec generation.
When `LLM_PROVIDER` is set, use the matching provider key env:
- `openai`: `OPENAI_API_KEY`
- `anthropic`: `ANTHROPIC_API_KEY`
- `gemini`: `GEMINI_API_KEY`
- `qwen`: `QWEN_API_KEY` (OpenAI-compatible endpoint)
- `deepseek`: `DEEPSEEK_API_KEY` (OpenAI-compatible endpoint)

## Output

Running the command writes one run log file to:

- `runs/<run_id>.json`
- The run file includes `stats`, `candidates`, `new_candidates`, `repo_cards`, `gaps`, `spec_results`, `index_summary`, and `logs`
- Dedup index is persisted at `specs/index.json`
- Generated specs are written to `specs/YYYY-MM-DD/<owner>__<repo>.json`

## Current Scope

This scaffold only verifies a minimal LangGraph TypeScript graph can run end-to-end:

- Read config from `github-topic-miner/config/miner.config.json`
- Execute a minimal StateGraph
- Write run log JSON into `runs/`

Part 1 includes repo discovery via GitHub Search API in a LangGraph node (`repo_finder`):

- Search repos for each configured topic
- Keep only the newest `maxNewReposPerRun` candidates by `pushed_at`
- Persist structured candidates into `runs/<run_id>.json`

Part 2 adds a LangGraph `deduper` node backed by `specs/index.json`:

- Skip repos already seen in previous runs (idempotent behavior)
- Persist last seen / last pushed metadata per `full_name`
- Emit `new_candidates` for downstream processing in later parts

`allowRefresh` (default `false`) lets updated repos re-enter `new_candidates` when their `pushed_at` is newer than the indexed value.

Part 3 adds a LangGraph `repo_card_builder` node:

- Build structured `repo_cards` from `new_candidates`
- Gather README, recent releases, recent non-PR issues, and root file names
- Record partial failures as `gaps` instead of failing the whole run

`repo_cards` are the factual input for Part 4 (LLM multi-role analysis). `gaps` is the explicit missing-data checklist for each repo.

E-Part 1 adds an Evidence Pack system in `repo_card_builder`:

- Each `repo_card` now includes `evidence[]` items with `id/type/source_url/title/excerpt/fetched_at/meta`
- README is split into multiple paragraph segments and converted into multiple evidence records
- Issues/Releases/Root files are converted into evidence with bounded counts
- Evidence stores excerpts only (not long full text), keeping run artifacts controllable
- `stats` includes `evidence_total` and `evidence_by_type`

E-Part 2 adds evidence-citation outputs in LLM multi-role:

- Scout/Inventor/Engineer/Skeptic/Synth outputs now include `evidence_ids`
- Final spec includes `citations` fields tied to evidence ids
- LLM outputs are checked for unknown evidence ids; unknown ids fail that repo generation
- `runs/<run_id>.json` includes `role_outputs` and `role_outputs_summary` for traceability

E-Part 3 adds an evidence-chain validator for final specs:

- Final spec is validated like a compiler pass before writing to `specs/`
- Hard-fail conditions:
  - unknown/missing evidence ids in `spec.citations`
  - missing citation coverage for required fields (`app`, `core_loop`, screens, commands, tables, acceptance tests)
  - empty `evidence_ids` on required citation entries
- Only specs that pass validation are written to `specs/YYYY-MM-DD/<owner>__<repo>.json`
- Validation outputs are persisted in `runs/<run_id>.json` under `evidence_reports` for audit/debug

E-Part 4 adds evidence artifacts persisted per successful spec:

- For each repo that passes E-Part 3 and writes a spec, an evidence artifact is written to `evidence/YYYY-MM-DD/<owner>__<repo>.json`
- Evidence artifact includes `meta` (`evidence_version`, run metadata, `spec_path`) plus full `evidence[]`
- `specs/index.json` now records `evidence_path` for successful repos
- `runs/<run_id>.json` includes `evidence_results` and `artifacts_summary`

L-Part 1 adds structured event logs:

- `runs/<run_id>.json` now includes `events[]` with fields: `ts/run_id/node/repo/level/event/data`
- Events are emitted across finder/deduper/card-builder/llm/validator/artifacts stages for replay and troubleshooting
- Event data is sanitized (redacted sensitive keys, truncated long strings)

L-Part 2 adds lightweight LLM audit logs:

- `runs/<run_id>.json` includes `llm_audits[]` per repo-role call
- Audit includes model, temperature, prompt hash (sha256), input size, parse/schema status, unknown-id count, retries, duration
- Full prompts and API keys are never persisted

Bridge System (Wire -> Canonical) now controls final spec emission:

- LLM synthesizer outputs a WireSpec (lenient schema)
- Bridge pipeline runs: `parse -> wire_validate -> normalize -> canonical_validate -> evidence_gate -> quality_gate`
- If gate fails, repair is attempted (max 2) with citations-only diff repair
- Only CanonicalSpec that passes Evidence + Quality gates is written to `specs/`
- Per-repo bridge reports are written to `reports/YYYY-MM-DD/<owner>__<repo>.json`
- `runs/<run_id>.json` includes `per_repo_bridge` summary for quick triage
- Legacy direct-schema/fixer drift strategies were removed; bridge pipeline is the only spec emission path.

E-Part 5 adds Gap Loop (evidence enrichment + iterative regenerate):

- When bridge fails due evidence/quality gaps, the repo enters iterative loop (`maxIters`)
- Each iter can enrich evidence (README fallback + extra issues/releases) then rerun synth + bridge
- Strict gates stay unchanged (`coverage_ratio=1`, `unknown_ids_count=0`, `empty_fields_count=0`)
- Iter reports are written to:
  - `reports/YYYY-MM-DD/<owner>__<repo>__iter1.json`
  - `reports/YYYY-MM-DD/<owner>__<repo>__iter2.json`
  - final successful/default report: `reports/YYYY-MM-DD/<owner>__<repo>.json`
- Run output now includes `per_repo_gap_loop` for attempts/evidence-added/final-error tracking
- Events and llm audits include iteration context for replay/audit

Stage 6 adds Stability + Cost Control:

- Budget controls:
  - per-run caps: `maxReposPerRun`, `maxWallTimeSeconds`, `maxTotalLlmCallsPerRun`, `maxTotalTokensApproxPerRun`
  - per-repo caps: `maxGapItersPerRepo`, `maxLlmCallsPerRepo`, `maxRepairAttempts`
  - events include `BUDGET_STOP_RUN` / `BUDGET_STOP_REPO` and run-end `RUN_BUDGET_SUMMARY`
- Fail taxonomy:
  - failures are classified into stable kinds (`FETCH_FAILED`, `QUALITY_GATE_EMPTY_CITATIONS`, `EVIDENCE_GATE_UNKNOWN_ID`, etc.)
  - run output includes `fail_taxonomy_summary`
  - each failed repo in `spec_results` includes `fail_kind`, `fail_message`, and `hints`
- Regression suite:
  - configurable in `config.regression`
  - output files:
    - `regression/<suiteName>/<YYYY-MM-DD>/<run_id>.json`
    - `regression/<suiteName>/latest.json`
  - events include `REGRESSION_START/OK/FAIL`
- run output includes `regression_result_path` and `regression_failed`

Performance + Throughput Optimization (A):

- LLM pruning:
  - config `pruning.*`
  - iter>=2 supports strategy-based role skipping (default synth-only)
  - events: `PRUNE_ITER_STRATEGY`, `PRUNE_SKIP_ROLE`, `PRUNE_RERUN_SYNTH_WITHOUT_ENRICH`
- Evidence selection is now failure-focused:
  - `selectEvidenceForLLM(..., focusHint)` scores evidence by gap/failure hints
  - events: `EVIDENCE_SELECTED` with focus summary and type counts
- GitHub fetch throughput:
  - per-repo fetch batch uses concurrent `Promise.allSettled`
  - local cache at `cache/github/<owner>__<repo>/<endpoint>.json`
  - events: `CACHE_HIT`, `CACHE_MISS`, `GITHUB_FETCH_BATCH_START`, `GITHUB_FETCH_BATCH_OK`

Logic/Stability Optimization (B):

- Bridge cover pass:
  - after normalize, local `ensureCitationCoverage()` only adds missing citation keys with empty arrays
  - does not auto-fill evidence ids; strict quality gate remains unchanged
  - events: `BRIDGE_COVER_ADDED_KEYS`
- Repair is now patch-only:
  - repair output is strict `CitationsPatch` (only citations diff keys)
  - apply step updates citations only, never rewrites business fields
  - events: `REPAIR_PATCH_START/OK/FAIL`, `REPAIR_PATCH_APPLIED`
- Layered retries:
  - GitHub fetch uses retry only for network/429/5xx
  - no retry for 401/403/404
  - events: `GITHUB_RETRY`, `GITHUB_RETRY_GIVEUP`, `FETCH_FAILED_FINAL`
- LLM calls do not use blind transport retries; recovery remains controlled by bridge repair + gap loop

## GitHub Actions 自动运行

- Workflow 文件：`.github/workflows/miner.yml`
- 触发方式：
  - `schedule`: 每天 03:00 UTC
  - `workflow_dispatch`: 手动触发，可传 `topic` / `maxReposPerRun` / `dryRun`
  - `push`: 仅当 workflow/scripts/config/package 相关文件变更时触发

- 必需 Secrets：
  - `OPENAI_API_KEY`（至少配置你当前使用的 provider key）
- 可选 Secrets：
  - `TOPIC_DEFAULT`（手动触发未传 topic 时使用）
  - 如需更高 GitHub API 配额，可配置 PAT 并替换默认 `GITHUB_TOKEN`

- 运行命令：
  - Actions 使用 `npm run miner:ci`
  - `ci-runner` 会按输入覆盖 `TOPIC` 和 `MAX_REPOS_PER_RUN`（只在本次运行生效）

- 产物提交目录：
  - `specs/`
  - `evidence/`
  - `reports/`
  - `runs/`
  - `specs/index.json`
  - `regression/`（如果启用）

- 防止自触发循环：
  - 提交信息包含 `[skip actions]`
  - `push.paths-ignore` 忽略 `specs/evidence/reports/runs/regression` 产物目录

- 失败排查：
  - 查看 Actions job logs
  - 下载 artifacts（包含 `runs/**` 与 `reports/**`，以及相关产物）

## Topics 初始池（github/explore）

- 生成脚本：
  - `npm run topics:bootstrap`
- 数据来源：
  - `github/explore` 仓库中的 `topics/` 与 `_topics/`
- 输出文件：
  - `github-topic-miner/config/topics/raw_pool.json`
  - `github-topic-miner/config/topics/candidate_pool.json`
  - `github-topic-miner/config/topics/active_pool.json`
  - `github-topic-miner/config/topics/seed_pool.json`（首批运行池）

建议流程：
- 先运行脚本生成三层池（raw/candidate/active）
- 生成首批池：`npm run topics:seed`
- 一键刷新（bootstrap + seed）：`npm run topics:refresh`
- 运行时自动从 `seed_pool.json` 选 topic（见 `topicSelection`）

### Topic Selection（运行时自动选题）

- 配置位置：`github-topic-miner/config/miner.config.json` -> `topicSelection`
- 默认策略：
  - 单次选 `batchSize=10`
  - 分层配额：`core 50% / adjacent 30% / explore 20%`
  - 游标轮换：每次 run 向后推进，避免固定重复
  - 冷却窗口：最近 `cooldownRuns=3` 次 run 已选 topic 暂不重复
  - 低产冻结：某 topic 连续 `3` 次结果为 0，则冻结 `3` 次 run
- 状态文件：`specs/topic_selection_state.json`
- 每次 run 的选题摘要会写入 `runs/<run_id>.json` 的 `topic_selection_summary`

### Topics 自动补充（GitHub Actions）

- Workflow：`.github/workflows/topics-refresh.yml`
- 触发方式：
  - 每周日 02:00 UTC 定时
  - `workflow_dispatch` 手动触发
- 执行内容：
  - `npm run topics:refresh`
  - 自动提交更新后的 topic 池文件：
    - `github-topic-miner/config/topics/raw_pool.json`
    - `github-topic-miner/config/topics/candidate_pool.json`
    - `github-topic-miner/config/topics/active_pool.json`
    - `github-topic-miner/config/topics/seed_pool.json`
- 防循环：
  - commit message 含 `[skip actions]`
  - `push.paths-ignore` 忽略 topic 池产物路径

Part 4 adds a LangGraph `llm_spec_generator` node with role flow:

- `Scout -> Inventor -> Engineer -> Skeptic -> Synthesizer`
- Each role returns strict JSON and is validated with zod schema
- Synthesizer output is validated by `FinalSpecSchema` and saved as the final design spec
- Single repo failure does not fail the whole run; results are tracked in `spec_results`
