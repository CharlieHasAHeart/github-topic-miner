import type { EvidenceItem, RepoCard, RepoCardIssueItem, RepoCardReleaseItem } from "./types";

const MAX_README_SEGMENTS = 8;
const README_EXCERPT_MAX = 1200;
const ISSUE_EVIDENCE_MAX = 10;
const RELEASE_EVIDENCE_MAX = 3;
const ROOT_FILES_EXCERPT_MAX = 1500;
const DEFAULT_EVIDENCE_MAX_TOTAL = 30;

export interface EvidenceFocusHint {
  need_commands?: boolean;
  need_tests?: boolean;
  need_tables?: boolean;
  need_screens?: boolean;
  need_core?: boolean;
  keywords?: string[];
}

function formatId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, "0")}`;
}

export function safeExcerpt(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function splitReadmeIntoSegments(readmeText: string): string[] {
  return readmeText
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 80)
    .slice(0, MAX_README_SEGMENTS)
    .map((segment) => safeExcerpt(segment, README_EXCERPT_MAX));
}

export function buildReadmeEvidence(
  repoFullName: string,
  repoUrl: string,
  readmeText: string,
  fetchedAt: string,
  language?: string | null,
): EvidenceItem[] {
  const segments = splitReadmeIntoSegments(readmeText);
  return segments.map((segment, idx) => ({
    id: formatId("E-RD-", idx + 1),
    type: "readme",
    source_url: `${repoUrl}#readme`,
    title: `README (segment ${idx + 1})`,
    excerpt: segment,
    fetched_at: fetchedAt,
    meta: {
      repo_full_name: repoFullName,
      segment: idx + 1,
      language: language ?? null,
    },
  }));
}

export function buildIssuesEvidence(
  repoFullName: string,
  issuesItems: RepoCardIssueItem[],
  fetchedAt: string,
  max = ISSUE_EVIDENCE_MAX,
): EvidenceItem[] {
  return issuesItems.slice(0, max).map((issue, idx) => ({
    id: formatId("E-IS-", idx + 1),
    type: "issue",
    source_url: issue.url,
    title: issue.title,
    excerpt: safeExcerpt(`${issue.title} (state:${issue.state})`, 500),
    fetched_at: fetchedAt,
    meta: {
      repo_full_name: repoFullName,
      number: issue.number,
    },
  }));
}

export function buildReleasesEvidence(
  repoFullName: string,
  releasesItems: RepoCardReleaseItem[],
  repoUrl: string,
  fetchedAt: string,
  max = RELEASE_EVIDENCE_MAX,
): EvidenceItem[] {
  return releasesItems.slice(0, max).map((release, idx) => ({
    id: formatId("E-RL-", idx + 1),
    type: "release",
    source_url: `${repoUrl}/releases`,
    title: release.tag_name ?? release.name ?? `release-${idx + 1}`,
    excerpt: safeExcerpt(
      release.body_excerpt && release.body_excerpt.trim().length > 0
        ? release.body_excerpt
        : "Release metadata available, release notes body is empty.",
      README_EXCERPT_MAX,
    ),
    fetched_at: fetchedAt,
    meta: {
      repo_full_name: repoFullName,
      tag_name: release.tag_name ?? undefined,
      published_at: release.published_at ?? undefined,
    },
  }));
}

export function buildRootFilesEvidence(
  repoFullName: string,
  repoUrl: string,
  rootFiles: string[],
  fetchedAt: string,
): EvidenceItem[] {
  if (rootFiles.length === 0) {
    return [];
  }

  return [
    {
      id: "E-RF-001",
      type: "root_files",
      source_url: repoUrl,
      title: "ROOT_FILES",
      excerpt: safeExcerpt(rootFiles.slice(0, 50).join(", "), ROOT_FILES_EXCERPT_MAX),
      fetched_at: fetchedAt,
      meta: {
        repo_full_name: repoFullName,
        path: "/",
      },
    },
  ];
}

export function buildEvidencePack(repoCard: RepoCard, fetchedAt: string): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];

  if (repoCard.readme.fetched && repoCard.readme.text) {
    evidence.push(
      ...buildReadmeEvidence(
        repoCard.full_name,
        repoCard.html_url,
        repoCard.readme.text,
        fetchedAt,
        repoCard.language,
      ),
    );
  }

  if (repoCard.issues.fetched && repoCard.issues.items.length > 0) {
    evidence.push(...buildIssuesEvidence(repoCard.full_name, repoCard.issues.items, fetchedAt));
  }

  if (repoCard.releases.fetched && repoCard.releases.items.length > 0) {
    evidence.push(
      ...buildReleasesEvidence(
        repoCard.full_name,
        repoCard.releases.items,
        repoCard.html_url,
        fetchedAt,
      ),
    );
  }

  if (repoCard.root_files && repoCard.root_files.length > 0) {
    evidence.push(
      ...buildRootFilesEvidence(repoCard.full_name, repoCard.html_url, repoCard.root_files, fetchedAt),
    );
  }

  const seenIds = new Set<string>();
  return evidence.map((item, idx) => {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      return item;
    }
    const patched = { ...item, id: `${item.id}-${idx + 1}` };
    seenIds.add(patched.id);
    return patched;
  });
}

function byTypePriority(item: EvidenceItem): number {
  if (item.type === "readme") return 0;
  if (item.type === "issue") return 1;
  if (item.type === "release") return 2;
  return 3;
}

function parseIssueKeywordScore(title: string, keywords: string[]): number {
  const lower = title.toLowerCase();
  return keywords.reduce((acc, word) => (lower.includes(word) ? acc + 1 : acc), 0);
}

function includesAny(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (lower.includes(word)) score += 1;
  }
  return score;
}

function normalizeFocusHint(focusHint?: EvidenceFocusHint | string[] | null): EvidenceFocusHint {
  if (!focusHint) return {};
  if (Array.isArray(focusHint)) return { keywords: focusHint };
  return focusHint;
}

function isLikelyCoreReadme(item: EvidenceItem): boolean {
  return item.type === "readme" && (item.meta?.segment ?? 99) <= 2;
}

function evidenceScore(item: EvidenceItem, hint: EvidenceFocusHint): number {
  let score = 0;
  if (item.type === "readme") score += 5;
  if (item.type === "issue") score += 3;
  if (item.type === "release") score += 2;
  if (item.type === "root_files") score += 2;

  const text = `${item.title} ${item.excerpt}`;
  if (hint.need_commands || hint.need_tests) {
    if (item.type === "issue") score += 3;
    if (item.type === "release") score += 2;
    score += Math.min(2, includesAny(text, ["command", "api", "save", "list", "delete", "import", "export"]));
  }
  if (hint.need_tables) {
    if (item.type === "root_files") score += 4;
    if (item.type === "readme") score += 1;
    score += Math.min(3, includesAny(text, ["sqlite", "schema", "migrate", "db", "table", "index"]));
  }
  if (hint.need_screens) {
    if (item.type === "readme") score += 2;
    score += Math.min(2, includesAny(text, ["ui", "screen", "settings", "dashboard", "view"]));
  }
  if (hint.need_core && isLikelyCoreReadme(item)) {
    score += 4;
  }
  const keywords = hint.keywords ?? [];
  score += Math.min(4, includesAny(text, keywords));
  return score;
}

export function selectEvidenceForLLM(
  evidencePack: EvidenceItem[],
  maxTotal = DEFAULT_EVIDENCE_MAX_TOTAL,
  focusHint?: EvidenceFocusHint | string[] | null,
): EvidenceItem[] {
  const hint = normalizeFocusHint(focusHint);
  const pool = evidencePack.map((item, idx) => ({
    item,
    idx,
    score: evidenceScore(item, hint),
  }));

  const minReadme = 2;
  const minIssues = hint.need_commands || hint.need_tests ? 8 : 4;
  const minReleases = 1;
  const minRootFiles = 1;

  const selected: EvidenceItem[] = [];
  const takeByType = (type: EvidenceItem["type"], n: number) => {
    const candidates = pool
      .filter((entry) => entry.item.type === type && !selected.some((s) => s.id === entry.item.id))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .slice(0, n)
      .map((entry) => entry.item);
    selected.push(...candidates);
  };

  takeByType("readme", minReadme);
  takeByType("issue", minIssues);
  takeByType("release", minReleases);
  takeByType("root_files", minRootFiles);

  const remaining = pool
    .filter((entry) => !selected.some((s) => s.id === entry.item.id))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((entry) => entry.item);
  for (const item of remaining) {
    if (selected.length >= Math.max(1, maxTotal)) break;
    selected.push(item);
  }

  return selected.slice(0, Math.max(1, maxTotal));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

export function extractGapKeywords(params: {
  report?: {
    final?: {
      reason?: string;
    };
    stages?: Array<{
      name: string;
      error_detail?: string;
    }>;
  } | null;
  emptyFields?: string[];
  skepticText?: string[];
}): string[] {
  const seeds = new Set<string>();
  const pushTokens = (text: string) => {
    for (const token of tokenize(text)) seeds.add(token);
  };

  for (const field of params.emptyFields ?? []) pushTokens(field);
  for (const text of params.skepticText ?? []) pushTokens(text);
  if (params.report?.final?.reason) pushTokens(params.report.final.reason);
  for (const stage of params.report?.stages ?? []) {
    if (stage.error_detail) pushTokens(stage.error_detail);
  }

  const expandIfPresent = (needle: string, expansions: string[]) => {
    if (!seeds.has(needle)) return;
    for (const term of expansions) seeds.add(term);
  };
  expandIfPresent("commands", ["api", "command", "save", "list", "delete", "import", "export"]);
  expandIfPresent("tables", ["sqlite", "database", "schema", "table", "index"]);
  expandIfPresent("screens", ["ui", "settings", "search", "list", "detail"]);
  expandIfPresent("tests", ["test", "acceptance", "cli", "e2e", "export", "import"]);
  expandIfPresent("acceptance_tests", ["test", "acceptance", "cli", "e2e", "export", "import"]);

  return [...seeds].slice(0, 8);
}
