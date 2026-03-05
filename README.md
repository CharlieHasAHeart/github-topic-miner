# GitHub Topic Miner

基于 LangGraph + TypeScript 的 GitHub 项目挖掘与规格生成流水线。

它会从 topic 批量发现仓库，抓取证据（README/Issue/Release/根目录文件），经过多角色 LLM 分析与 Bridge 质量闸门，最终输出可审计的结构化规格文档。

## 核心能力

- 自动发现候选仓库（GitHub Search API）
- 去重与刷新控制（`specs/index.json`）
- 证据包构建（Evidence Pack）
- 多角色调用链：`Scout -> Inventor -> Engineer -> Skeptic -> Synth`
- Wire -> Canonical Bridge 校验与修复
- 失败分类、预算控制、回归基线
- 全链路审计：事件日志 + LLM 调用审计

## 处理流程

1. `repo_finder`：按 topic 搜索并排序候选仓库
2. `deduper`：与 `specs/index.json` 比较，过滤已处理仓库
3. `repo_card_builder`：抓取仓库信息并生成 evidence
4. `llm_spec_generator`：
   - 先跑 4 个角色（Scout/Inventor/Engineer/Skeptic）
   - 再用 Synth 结合角色上下文输出 WireSpec
   - 进入 Bridge：`parse -> wire_validate -> normalize -> canonical_validate -> evidence_gate -> quality_gate`
   - 不通过时触发 repair/gap loop/enrich evidence
5. 产物落盘：`specs/`、`evidence/`、`reports/`、`runs/`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env`（至少提供一个 LLM provider key）：

```bash
# 可选：提高 GitHub 速率上限
GITHUB_TOKEN=...

# 选择 provider（openai / anthropic / gemini / qwen / deepseek）
LLM_PROVIDER=qwen

# 按 provider 设置 key
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
QWEN_API_KEY=...
DEEPSEEK_API_KEY=...
```

可选 base url / model 环境变量也支持（见 `github-topic-miner/scripts/llm.ts`）。

### 3. 本地运行

```bash
npm run miner:dev
```

或先编译再运行：

```bash
npm run miner
```

## 关键配置

主配置文件：`github-topic-miner/config/miner.config.json`

重要字段：

- `topics` / `perTopicLimit` / `minStars` / `pushedWithinDays`
- `maxNewReposPerRun` / `allowRefresh`
- `llm.provider` / `llm.model` / `llm.temperature`
- `gapLoop.*`：失败后的迭代补证与重试策略
- `pruning.*`：迭代 2+ 的角色裁剪策略
- `budget.*`：运行级/仓库级预算上限
- `regression.*`：回归基线开关与阈值
- `topicSelection.*`：运行时自动选题策略

## 输出与目录

每次运行会生成：

- `runs/<run_id>.json`：总运行记录（最核心审计文件）
- `specs/YYYY-MM-DD/<owner>__<repo>.json`：最终 CanonicalSpec
- `evidence/YYYY-MM-DD/<owner>__<repo>.json`：证据归档
- `reports/YYYY-MM-DD/<owner>__<repo>.json`：Bridge 详细报告
- `specs/index.json`：去重索引

`runs/<run_id>.json` 包含：

- `stats`、`candidates`、`new_candidates`、`repo_cards`
- `role_outputs`、`role_outputs_summary`
- `llm_audits`、`events`
- `spec_results`、`evidence_results`、`evidence_reports`
- `per_repo_bridge`、`per_repo_gap_loop`
- `fail_taxonomy_summary`

## 多角色机制说明

当前实现中，四角色会被真实调用并写入 `role_outputs`：

- `scout`：信息扫描与机会识别
- `inventor`：方案与产品方向
- `engineer`：工程可行性与落地路径
- `skeptic`：风险、漏洞、反例挑战
- `synth`：综合角色上下文与证据，产出 WireSpec

当进入高迭代且启用 pruning 时，角色可能按策略被跳过（例如迭代 2+ 默认 `synth_only`），系统会在事件中记录 `PRUNE_SKIP_ROLE`。

## 可用脚本

```bash
npm run build
npm run miner
npm run miner:dev
npm run miner:ci
npm run test:unit
npm run topics:bootstrap
npm run topics:seed
npm run topics:refresh
npm run specs:migrate:v3
npm run specs:validate:v3
```

## GitHub Actions

- `/.github/workflows/miner.yml`
  - 定时运行 + 手动触发 + 指定路径变更触发
  - 使用 `npm run miner:ci`
- `/.github/workflows/topics-refresh.yml`
  - 定时刷新 topic 池

建议在仓库 Secrets 中配置：

- 至少一个 provider API Key（如 `OPENAI_API_KEY` 或 `QWEN_API_KEY`）
- 可选 `GITHUB_TOKEN`（PAT）提升 API 配额

## 常见问题

1. `Could not resolve host: github.com`
- 运行环境无外网或 DNS 不可达，先检查网络策略。

2. `LLM HTTP 401/403`
- provider key 缺失、错误，或 provider/model 不匹配。

3. `spec not generated` / `bridge failed`
- 查看 `reports/YYYY-MM-DD/...json` 的 `final.reason` 与 `stages`。

4. 产物很多、成本高
- 调低 `maxNewReposPerRun`、`maxGapItersPerRepo`、`maxEvidenceLinesForPrompt`，并启用更激进 pruning。

## 开发说明

- 代码目录：`github-topic-miner/scripts/`
- 入口：`github-topic-miner/scripts/run.ts`
- 图编排：`github-topic-miner/scripts/graph.ts`
- LLM 调用：`github-topic-miner/scripts/llm.ts`
- Bridge：`github-topic-miner/scripts/bridge/`

