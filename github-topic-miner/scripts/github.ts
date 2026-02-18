import type { CandidateRepo, RepoCardIssueItem, RepoCardReleaseItem } from "./types";
import { getCache, repoEndpointCacheKey, setCache } from "./cache";
import { withRetry } from "./retry";

interface SearchReposByTopicParams {
  topic: string;
  perTopicLimit: number;
  minStars: number;
  pushedWithinDays: number;
  token?: string;
  appendLog?: (line: string) => void;
}

interface GitHubSearchResponse {
  items: Array<{
    full_name: string;
    html_url: string;
    description: string | null;
    topics?: string[];
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    license: { spdx_id: string | null } | null;
    default_branch: string;
    pushed_at: string;
    created_at: string;
  }>;
}

interface GitHubRepoResponseItem {
  full_name: string;
  html_url: string;
  description: string | null;
  topics?: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license: { spdx_id: string | null } | null;
  default_branch: string;
  pushed_at: string;
  created_at: string;
}

interface GitHubIssueResponseItem {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  pull_request?: unknown;
}

interface GitHubReleaseResponseItem {
  name: string | null;
  tag_name: string | null;
  published_at: string | null;
  body: string | null;
}

interface ReadmeMetadataResponse {
  download_url?: string | null;
}

interface ContentsFileResponse {
  download_url?: string | null;
  html_url?: string | null;
  sha?: string | null;
  type?: string;
}

export interface FetchOptions {
  onCacheEvent?: (event: "CACHE_HIT" | "CACHE_MISS", data: { repo: string; key: string }) => void;
  onRetryEvent?: (
    event: "GITHUB_RETRY" | "GITHUB_RETRY_GIVEUP",
    data: { repo: string; endpoint: string; attempt: number; status?: number; reason?: string },
  ) => void;
}

function formatDateYYYYMMDD(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildPushedSinceDate(pushedWithinDays: number): string {
  const now = new Date();
  const since = new Date(now.getTime() - pushedWithinDays * 24 * 60 * 60 * 1000);
  return formatDateYYYYMMDD(since);
}

function buildHeaders(token?: string, accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "github-topic-miner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

class GitHubRequestError extends Error {
  status?: number;
  endpoint?: string;
  repo?: string;
}

function isRetriableGitHubError(error: unknown): boolean {
  const err = error as GitHubRequestError;
  if (typeof err?.status === "number") {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status <= 599) return true;
    return false;
  }
  return true;
}

async function fetchWithRetry(params: {
  url: string;
  init: RequestInit;
  repo: string;
  endpoint: string;
  options?: FetchOptions;
}): Promise<Response> {
  return withRetry(
    async () => {
      const response = await fetch(params.url, params.init);
      if (!response.ok) {
        const body = await response.text();
        const error = new GitHubRequestError(
          `GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
        );
        error.status = response.status;
        error.endpoint = params.endpoint;
        error.repo = params.repo;
        throw error;
      }
      return response;
    },
    {
      retries: 2,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      jitter: true,
      retryOn: isRetriableGitHubError,
      onRetry: ({ attempt, error }) => {
        const err = error as GitHubRequestError;
        params.options?.onRetryEvent?.("GITHUB_RETRY", {
          repo: params.repo,
          endpoint: params.endpoint,
          attempt,
          status: err.status,
        });
      },
      onGiveup: ({ attempt, error }) => {
        const err = error as GitHubRequestError;
        params.options?.onRetryEvent?.("GITHUB_RETRY_GIVEUP", {
          repo: params.repo,
          endpoint: params.endpoint,
          attempt,
          status: err.status,
          reason: err.message,
        });
      },
    },
  );
}

function excerpt(text: string | null, maxChars: number): string | null {
  if (!text) {
    return null;
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export async function searchReposByTopic(
  params: SearchReposByTopicParams,
): Promise<CandidateRepo[]> {
  const { topic, perTopicLimit, minStars, pushedWithinDays, token, appendLog } = params;
  const pushedSince = buildPushedSinceDate(pushedWithinDays);
  const q = `topic:${topic} stars:>=${minStars} pushed:>=${pushedSince}`;
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", q);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(perTopicLimit));
  url.searchParams.set("page", "1");

  if (!token) {
    appendLog?.(
      `[repo_finder] GITHUB_TOKEN not set; searching "${topic}" anonymously (rate limit may be low).`,
    );
  }
  const response = await fetchWithRetry({
    url: url.toString(),
    init: { method: "GET", headers: buildHeaders(token) },
    repo: topic,
    endpoint: "search_repositories",
  });
  const data = (await response.json()) as GitHubSearchResponse;
  return data.items.map((item) => ({
    full_name: item.full_name,
    html_url: item.html_url,
    description: item.description,
    topics: item.topics ?? [],
    language: item.language,
    stargazers_count: item.stargazers_count,
    forks_count: item.forks_count,
    open_issues_count: item.open_issues_count,
    license_spdx_id: item.license?.spdx_id ?? null,
    default_branch: item.default_branch,
    pushed_at: item.pushed_at,
    created_at: item.created_at,
  }));
}

export async function fetchRepoByFullName(fullName: string, token?: string): Promise<CandidateRepo> {
  const url = `https://api.github.com/repos/${fullName}`;
  const response = await fetchWithRetry({
    url,
    init: { method: "GET", headers: buildHeaders(token) },
    repo: fullName,
    endpoint: "repo",
  });
  const item = (await response.json()) as GitHubRepoResponseItem;
  return {
    full_name: item.full_name,
    html_url: item.html_url,
    description: item.description,
    topics: item.topics ?? [],
    language: item.language,
    stargazers_count: item.stargazers_count,
    forks_count: item.forks_count,
    open_issues_count: item.open_issues_count,
    license_spdx_id: item.license?.spdx_id ?? null,
    default_branch: item.default_branch,
    pushed_at: item.pushed_at,
    created_at: item.created_at,
  };
}

const README_MAX_CHARS = 12000;
const RELEASE_BODY_EXCERPT_MAX_CHARS = 2000;

export async function fetchReadmeText(
  fullName: string,
  token?: string,
  options?: FetchOptions,
): Promise<{ text: string; truncated: boolean; source: "api" | "raw"; bytes: number }> {
  const key = repoEndpointCacheKey(fullName, "readme");
  const cached = getCache(key);
  if (cached.hit && cached.data && typeof cached.data === "object") {
    options?.onCacheEvent?.("CACHE_HIT", { repo: fullName, key });
    return cached.data as { text: string; truncated: boolean; source: "api" | "raw"; bytes: number };
  }
  options?.onCacheEvent?.("CACHE_MISS", { repo: fullName, key });

  const readmeApiUrl = `https://api.github.com/repos/${fullName}/readme`;

  try {
    const response = await fetchWithRetry({
      url: readmeApiUrl,
      init: {
        method: "GET",
        headers: buildHeaders(token, "application/vnd.github.raw"),
      },
      repo: fullName,
      endpoint: "readme",
      options,
    });
    const rawText = await response.text();
    const truncated = rawText.length > README_MAX_CHARS;
    const text = truncated ? rawText.slice(0, README_MAX_CHARS) : rawText;
    const value = {
      text,
      truncated,
      source: "api" as const,
      bytes: Buffer.byteLength(rawText, "utf-8"),
    };
    setCache(key, value);
    return value;
  } catch (apiError) {
    const metadataResponse = await fetchWithRetry({
      url: readmeApiUrl,
      init: { method: "GET", headers: buildHeaders(token) },
      repo: fullName,
      endpoint: "readme_meta",
      options,
    });
    const metadata = (await metadataResponse.json()) as ReadmeMetadataResponse;
    if (!metadata.download_url) {
      throw apiError;
    }
    const rawResponse = await fetchWithRetry({
      url: metadata.download_url,
      init: {
        method: "GET",
        headers: {
          "User-Agent": "github-topic-miner",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      repo: fullName,
      endpoint: "readme_raw",
      options,
    });
    const rawText = await rawResponse.text();
    const truncated = rawText.length > README_MAX_CHARS;
    const text = truncated ? rawText.slice(0, README_MAX_CHARS) : rawText;
    const value = {
      text,
      truncated,
      source: "raw" as const,
      bytes: Buffer.byteLength(rawText, "utf-8"),
    };
    setCache(key, value);
    return value;
  }
}

export async function fetchLatestReleases(
  fullName: string,
  token?: string,
  limit = 3,
  options?: FetchOptions,
): Promise<RepoCardReleaseItem[]> {
  const key = repoEndpointCacheKey(fullName, `releases_${limit}`);
  const cached = getCache(key);
  if (cached.hit && Array.isArray(cached.data)) {
    options?.onCacheEvent?.("CACHE_HIT", { repo: fullName, key });
    return cached.data as RepoCardReleaseItem[];
  }
  options?.onCacheEvent?.("CACHE_MISS", { repo: fullName, key });
  const url = `https://api.github.com/repos/${fullName}/releases?per_page=${limit}`;
  const response = await fetchWithRetry({
    url,
    init: { method: "GET", headers: buildHeaders(token) },
    repo: fullName,
    endpoint: `releases_${limit}`,
    options,
  });
  const items = (await response.json()) as GitHubReleaseResponseItem[];
  const value = items.map((item) => ({
    name: item.name,
    tag_name: item.tag_name,
    published_at: item.published_at,
    body_excerpt: excerpt(item.body, RELEASE_BODY_EXCERPT_MAX_CHARS),
  }));
  setCache(key, value);
  return value;
}

export async function fetchReleases(
  fullName: string,
  token?: string,
  limit = 3,
  options?: FetchOptions,
): Promise<RepoCardReleaseItem[]> {
  return fetchLatestReleases(fullName, token, limit, options);
}

export async function fetchRecentIssues(
  fullName: string,
  token?: string,
  limit = 10,
  options?: FetchOptions,
): Promise<RepoCardIssueItem[]> {
  const key = repoEndpointCacheKey(fullName, `issues_${limit}`);
  const cached = getCache(key);
  if (cached.hit && Array.isArray(cached.data)) {
    options?.onCacheEvent?.("CACHE_HIT", { repo: fullName, key });
    return cached.data as RepoCardIssueItem[];
  }
  options?.onCacheEvent?.("CACHE_MISS", { repo: fullName, key });
  const url = `https://api.github.com/repos/${fullName}/issues?state=all&per_page=${limit}&sort=updated&direction=desc`;
  const response = await fetchWithRetry({
    url,
    init: { method: "GET", headers: buildHeaders(token) },
    repo: fullName,
    endpoint: `issues_${limit}`,
    options,
  });
  const items = (await response.json()) as GitHubIssueResponseItem[];
  const value = items
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      url: item.html_url,
    }));
  setCache(key, value);
  return value;
}

export async function fetchIssues(
  fullName: string,
  token?: string,
  limit = 10,
  options?: FetchOptions,
): Promise<RepoCardIssueItem[]> {
  return fetchRecentIssues(fullName, token, limit, options);
}

export async function fetchRootFiles(
  fullName: string,
  defaultBranch: string,
  token?: string,
  options?: FetchOptions,
): Promise<string[]> {
  const key = repoEndpointCacheKey(fullName, `root_files_${defaultBranch}`);
  const cached = getCache(key);
  if (cached.hit && Array.isArray(cached.data)) {
    options?.onCacheEvent?.("CACHE_HIT", { repo: fullName, key });
    return cached.data as string[];
  }
  options?.onCacheEvent?.("CACHE_MISS", { repo: fullName, key });
  const url = `https://api.github.com/repos/${fullName}/contents?ref=${encodeURIComponent(defaultBranch)}`;
  const response = await fetchWithRetry({
    url,
    init: { method: "GET", headers: buildHeaders(token) },
    repo: fullName,
    endpoint: `root_files_${defaultBranch}`,
    options,
  });
  const data = (await response.json()) as Array<{ name: string }> | { name: string };
  if (!Array.isArray(data)) {
    throw new Error("Root contents response is not an array.");
  }
  const value = data.slice(0, 50).map((item) => item.name);
  setCache(key, value);
  return value;
}

export async function fetchContentsFile(
  fullName: string,
  filePath: string,
  token?: string,
  options?: FetchOptions,
): Promise<{ text: string; html_url: string; download_url: string; sha: string | null }> {
  const key = repoEndpointCacheKey(fullName, `contents_${filePath}`);
  const cached = getCache(key);
  if (cached.hit && cached.data && typeof cached.data === "object") {
    options?.onCacheEvent?.("CACHE_HIT", { repo: fullName, key });
    return cached.data as { text: string; html_url: string; download_url: string; sha: string | null };
  }
  options?.onCacheEvent?.("CACHE_MISS", { repo: fullName, key });
  const url = `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(filePath)}`;
  const response = await fetchWithRetry({
    url,
    init: { method: "GET", headers: buildHeaders(token) },
    repo: fullName,
    endpoint: `contents_${filePath}`,
    options,
  });
  const data = (await response.json()) as ContentsFileResponse;
  if (data.type && data.type !== "file") {
    throw new Error(`Path is not a file: ${filePath}`);
  }
  if (!data.download_url) {
    throw new Error(`download_url missing for ${filePath}`);
  }
  const rawResponse = await fetchWithRetry({
    url: data.download_url,
    init: {
      method: "GET",
      headers: {
        "User-Agent": "github-topic-miner",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    repo: fullName,
    endpoint: `contents_raw_${filePath}`,
    options,
  });
  const rawText = await rawResponse.text();
  const value = {
    text: rawText,
    html_url: data.html_url ?? `https://github.com/${fullName}/blob/HEAD/${filePath}`,
    download_url: data.download_url,
    sha: data.sha ?? null,
  };
  setCache(key, value);
  return value;
}
