# GitHub 项目获取规则说明（GitHub Topic Miner）

本文档用“文字规则”描述该项目如何从 GitHub 获取候选仓库、如何筛选与去重、以及如何为后续分析收集事实证据（README / releases / issues / root files）。不包含代码片段，便于直接放入项目文档。

---

## 1. 目标与产出

### 1.1 目标
围绕一组 **topic**，自动发现“近期活跃”的 GitHub 仓库，并为每个仓库构建可审计的事实输入（repo card + evidence pack），供后续 LLM 生成 spec 使用。

### 1.2 主要产出（与获取规则相关）
- `runs/<run_id>.json`：一次运行的完整日志与中间产物（候选、去重结果、repo card、gaps 等）
- `specs/index.json`：去重索引（记录仓库是否已处理、上次看见/上次更新等）
- `repo_cards`：每个仓库的“事实卡片”（来自 GitHub API）
- `evidence[]`：对事实卡片做结构化证据化后的记录（含 id、类型、来源 URL、摘录等）

---

## 2. Repo Discovery（候选仓库发现规则）

### 2.1 发现方式：按 topic 使用 GitHub Search（Repositories）
系统会针对每个配置的 topic，向 GitHub 的仓库搜索接口发起查询，得到候选仓库列表。

### 2.2 查询约束（核心筛选条件）
对每个 topic 的查询都会同时施加以下限制：

1) **Topic 过滤**  
   - 只搜索带有该 topic 的仓库。

2) **Stars 下限（热度门槛）**  
   - 只保留 stars 数 ≥ `minStars` 的仓库。

3) **近期活跃（推送时间窗口）**  
   - 只保留 “最近 N 天内有 push” 的仓库（N = `pushedWithinDays`）。
   - 这个规则会被转换为一个 “起始日期 pushedSince = 当前日期 - N 天”，并筛选 pushed_at ≥ pushedSince 的仓库。

4) **排序规则**  
   - 按“最近更新”倒序返回，优先拿到最近活跃的仓库。

5) **每个 topic 的拉取上限**  
   - 每个 topic 最多拉取 `perTopicLimit` 条候选，避免单一 topic 占用过多配额。

> 直观理解：每个 topic 都会得到一批“最近一段时间内有更新、并且 stars 达标”的仓库候选集合。

### 2.3 认证与限流策略（获取稳定性）
- 如果配置了 `GITHUB_TOKEN`，请求会携带该 token，用于提高 GitHub API 的 rate limit（更稳定、可持续跑）。
- 如果没有 token，会以匿名方式请求，系统会记录提示日志（匿名配额更低，更容易触发 403/429）。

### 2.4 重试策略（网络/服务稳定性）
对 GitHub API 的请求实现了有限重试机制，用于应对短暂错误：
- **会重试**：429（限流）与 5xx（服务端错误）一类的可恢复错误
- **不重试**：401/403/404 等逻辑性/权限性错误（通常重试无意义）
- 重试次数有限，并带有延迟抖动（jitter），降低集中重试造成的二次限流风险

---

## 3. 候选集合合并与全局截断（跨 topic 统一筛选）

当系统完成“对每个 topic 各自搜索一批候选仓库”后，会进行一次全局合并与统一筛选，规则如下：

1) **合并规则**  
   - 将所有 topic 的搜索结果合并为一个候选池（一个数组/列表），用于统一排序。

2) **全局排序**  
   - 对合并后的候选池按 `pushed_at`（最后推送时间）倒序排序。
   - 排序目的：优先处理“最新 push 的仓库”，更贴近“新鲜项目”目标。

3) **全局上限截断（maxNewReposPerRun）**  
   - 只保留排序后最靠前的 `maxNewReposPerRun` 个候选仓库。
   - 注意：这是“全局上限”，不是“每个 topic 上限”。因此某些 topic 可能在本次 run 中分配不到名额（尤其当其他 topic 出现大量更活跃仓库时）。

---

## 4. 去重（Deduper）规则：specs/index.json 作为唯一真相源

系统会在进入“抓取 repo 事实数据（repo card）”前，对候选仓库进行去重过滤。

### 4.1 索引文件
- 去重索引存放在 `specs/index.json`
- 以仓库 `full_name` 作为 key（例如 `owner/repo`）
- 索引条目会记录：
  - 该仓库是否已被处理过
  - 上次看见该仓库的时间（last_seen）
  - 上次记录的 pushed_at（last_pushed_at）
  - 成功产物路径（如 spec_path / evidence_path）等

### 4.2 默认行为：幂等去重
- 如果仓库 `full_name` 已存在于索引中，则默认视为“已见过/已处理过”，本次运行会跳过，避免重复生成与重复成本。

### 4.3 allowRefresh：允许“更新过的老仓库”重新进入
当 `allowRefresh = true` 时，系统会放行一种情况：
- 仓库曾经处理过（索引中存在），但本次候选的 `pushed_at` **比索引中记录的 last_pushed_at 更新**  
  → 认为该仓库在上次处理后又有新提交，可重新进入后续流程。

如果 `allowRefresh = false`（默认），则即使仓库更新过也不会再进入。

### 4.4 去重后仍会做全局截断
去重完成得到的 `new_candidates` 会再按 `pushed_at` 倒序排序，并截断到 `maxNewReposPerRun`，保证后续抓取与 LLM 阶段的成本可控。

### 4.5 索引更新策略：本次见过的都要写回
无论仓库是否进入后续处理，系统都会将“本次 run 见过的仓库”信息写回 `specs/index.json`（更新 last_seen / last_pushed_at 等），确保索引持续反映最新观察结果。

---

## 5. Repo Card 事实抓取规则（Evidence 的来源）

对 `new_candidates`（去重后放行的仓库）系统会抓取 4 类事实数据，用于构建 repo card 与 evidence pack。

### 5.1 抓取数据类型与目的

1) README（项目概述）
- 目的：获取项目的说明、用法、架构信息的主要来源。
- 规则：
  - 优先使用 GitHub API 读取 README 内容。
  - 若 API 读取失败，会尝试从 README 的 `download_url` 获取 raw 内容作为 fallback。
  - 为控制体积，会对 README 文本做长度上限截断（避免 run 文件与 prompt 过大）。

2) Releases（最近发布）
- 目的：了解项目近期版本演进、功能变化。
- 规则：
  - 只取最新的有限条数（固定上限，如 3 条）。
  - release body 会提取摘要（excerpt），避免超长内容。

3) Issues（最近非 PR 的问题）
- 目的：了解项目当前问题、需求、活跃度与真实使用反馈。
- 规则：
  - 只取最近有限条数（固定上限，如 10 条）。
  - 明确过滤掉 Pull Request（只保留纯 issue），避免混入 PR 讨论噪音。

4) Root files（仓库根目录文件名）
- 目的：快速判断项目类型与结构（例如 package.json、Dockerfile、README、docs 等）。
- 规则：
  - 列出根目录前有限个文件名（例如最多 50 个），避免目录过大。

### 5.2 并发与容错（不让单点失败拖垮整次 run）
- 对同一个仓库的上述 4 类抓取，会并发执行以提升吞吐（Promise.allSettled 语义）。
- 任意一个抓取失败不会让整个仓库/整次 run 失败：
  - 系统会把失败项记录到 `gaps`（缺失清单），用于后续“补证据”或审计说明。
  - 其余成功的数据仍会用于构建 repo card。

### 5.3 缓存（吞吐与成本控制）
- GitHub 获取结果会落地到本地 cache 目录（按 repo 与 endpoint 分文件存储）。
- 后续重复访问相同 endpoint 时可能命中缓存，降低 GitHub API 压力与提升速度。

---

## 6. Evidence Pack 的生成规则（事实数据 → 可引用证据）

当 repo card 生成后，系统会将其中的 README / issues / releases / root_files 转换为统一结构的 `evidence[]`：

- 每条 evidence 具备：
  - `id`：唯一标识（后续所有 citations 必须引用这些 id）
  - `type`：readme / issue / release / root_file 等类型
  - `source_url`：来源链接（可审计）
  - `title`：标题（例如 issue 标题、release 名称）
  - `excerpt`：内容摘录（摘要化、受长度控制）
  - `fetched_at`：抓取时间戳
  - 其他 meta 信息

设计目标是：
- **可审计**：LLM 输出必须回指 evidence id，避免“无证据编造”
- **可控**：只存 excerpt，不存超长全文，保证 runs 与 specs 体积可控

---

## 7. 你在配置层面能影响哪些规则（常见参数）

以下参数会直接改变“获取 GitHub 项目”的行为（命名以项目配置语义为准）：

- `topics`：要挖掘的主题列表
- `minStars`：stars 下限
- `pushedWithinDays`：活跃窗口（N 天内有 push）
- `perTopicLimit`：每个 topic 最多拉取多少候选
- `maxNewReposPerRun`：全局本次 run 最多处理多少仓库
- `allowRefresh`：是否允许更新过的老仓库重新进入（基于 pushed_at 比较）
- `GITHUB_TOKEN`：建议配置，提高 rate limit、减少失败

---

## 8. 规则摘要（给管理/评审看的 10 行版）

1. 对每个 topic：只搜带该 topic、stars ≥ minStars、且最近 N 天有 push 的仓库  
2. 每个 topic 最多取 perTopicLimit 条，并按最近更新倒序  
3. 合并所有 topic 结果后，按 pushed_at 倒序  
4. 全局只保留 maxNewReposPerRun 个候选  
5. 用 specs/index.json 去重：默认已见过则跳过  
6. allowRefresh=true 时，只有 pushed_at 更新过的老仓库可重入  
7. 对放行仓库并发抓取 README / releases / issues（非 PR）/ root files  
8. 任意抓取失败记录到 gaps，不影响其他数据  
9. 将事实数据转换成 evidence[]（带 id、source_url、excerpt）  
10. 这些 evidence 将作为后续 LLM 输出 citations 的唯一可引用来源

---