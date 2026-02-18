import {
  buildIssuesEvidence,
  buildReleasesEvidence,
  buildRootFilesEvidence,
  buildReadmeEvidence,
} from "./evidence";
import { fetchContentsFile, fetchLatestReleases, fetchRecentIssues } from "./github";
import type { RepoCard, EvidenceItem } from "./types";

interface EnrichEvidenceParams {
  repoCard: RepoCard;
  reason: {
    lastBridgeReport: {
      final?: {
        reason?: string;
      };
    } | null;
    keywords: string[];
    iter: number;
  };
  config: NonNullable<
    import("./types").MinerConfig["gapLoop"]
  >;
  githubToken?: string;
  emit?: (event: {
    node: string;
    repo?: string | null;
    level: "info" | "warn" | "error";
    event: string;
    data?: Record<string, unknown>;
  }) => void;
}

function maxSequence(evidence: EvidenceItem[], prefix: string): number {
  let max = 0;
  for (const item of evidence) {
    if (!item.id.startsWith(prefix)) continue;
    const suffix = item.id.slice(prefix.length);
    const n = Number.parseInt(suffix, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function withReassignedIds(base: EvidenceItem[], incoming: EvidenceItem[], prefix: string): EvidenceItem[] {
  let current = maxSequence(base, prefix);
  return incoming.map((item) => {
    current += 1;
    return { ...item, id: `${prefix}${String(current).padStart(3, "0")}` };
  });
}

function dedupeEvidence(evidence: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of evidence) {
    const key = `${item.type}::${item.source_url}::${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function scoreIssueTitle(title: string, keywords: string[]): number {
  const text = title.toLowerCase();
  return keywords.reduce((acc, keyword) => (text.includes(keyword) ? acc + 1 : acc), 0);
}

export async function enrichEvidence(params: EnrichEvidenceParams): Promise<{
  updatedRepoCard: RepoCard;
  added: { readme: number; issue: number; release: number; root_files: number };
  totalEvidence: number;
}> {
  const { repoCard, reason, config, githubToken, emit } = params;
  const fetchedAt = new Date().toISOString();
  emit?.({
    node: "repo_card_builder",
    repo: repoCard.full_name,
    level: "info",
    event: "GAP_ENRICH_START",
    data: { iter: reason.iter, keywords: reason.keywords },
  });

  try {
    const additions: EvidenceItem[] = [];
    const added = { readme: 0, issue: 0, release: 0, root_files: 0 };
    const readmeEvidenceCount = repoCard.evidence.filter((item) => item.type === "readme").length;

    if (config.readmeFallbackEnabled && readmeEvidenceCount < 2) {
      for (const path of config.readmeFallbackPaths) {
        try {
          const file = await fetchContentsFile(repoCard.full_name, path, githubToken, {
            onCacheEvent: (event, data) => {
              emit?.({
                node: "repo_card_builder",
                repo: data.repo,
                level: "info",
                event,
                data: { key: data.key, iter: reason.iter },
              });
            },
            onRetryEvent: (event, data) => {
              emit?.({
                node: "repo_card_builder",
                repo: data.repo,
                level: event === "GITHUB_RETRY" ? "warn" : "error",
                event,
                data: { ...data, iter: reason.iter },
              });
            },
          });
          if (!file.text) continue;
          const chunks = buildReadmeEvidence(
            repoCard.full_name,
            repoCard.html_url,
            file.text,
            fetchedAt,
            repoCard.language,
          );
          const reassigned = withReassignedIds([...repoCard.evidence, ...additions], chunks, "E-RD-");
          additions.push(...reassigned);
          added.readme += reassigned.length;
          break;
        } catch {
          // Try next fallback path.
        }
      }
    }

    try {
      const extraIssues = await fetchRecentIssues(
        repoCard.full_name,
        githubToken,
        config.issuesExtraLimit,
        {
          onCacheEvent: (event, data) => {
            emit?.({
              node: "repo_card_builder",
              repo: data.repo,
              level: "info",
              event,
              data: { key: data.key, iter: reason.iter },
              });
            },
          onRetryEvent: (event, data) => {
            emit?.({
              node: "repo_card_builder",
              repo: data.repo,
              level: event === "GITHUB_RETRY" ? "warn" : "error",
              event,
              data: { ...data, iter: reason.iter },
            });
          },
        },
      );
      const rankedIssues = config.issuesKeywordBoost
        ? [...extraIssues].sort(
            (a, b) =>
              scoreIssueTitle(b.title, reason.keywords) - scoreIssueTitle(a.title, reason.keywords),
          )
        : extraIssues;
      const selectedIssues = rankedIssues.slice(0, config.issuesKeywordTopK);
      const issueEvidence = buildIssuesEvidence(
        repoCard.full_name,
        selectedIssues,
        fetchedAt,
        config.issuesKeywordTopK,
      );
      const reassigned = withReassignedIds([...repoCard.evidence, ...additions], issueEvidence, "E-IS-");
      additions.push(...reassigned);
      added.issue += reassigned.length;
    } catch {
      // Best effort.
    }

    try {
      const extraReleases = await fetchLatestReleases(
        repoCard.full_name,
        githubToken,
        config.releasesExtraLimit,
        {
          onCacheEvent: (event, data) => {
            emit?.({
              node: "repo_card_builder",
              repo: data.repo,
              level: "info",
              event,
              data: { key: data.key, iter: reason.iter },
              });
            },
          onRetryEvent: (event, data) => {
            emit?.({
              node: "repo_card_builder",
              repo: data.repo,
              level: event === "GITHUB_RETRY" ? "warn" : "error",
              event,
              data: { ...data, iter: reason.iter },
            });
          },
        },
      );
      const releaseEvidence = buildReleasesEvidence(
        repoCard.full_name,
        extraReleases,
        repoCard.html_url,
        fetchedAt,
        config.releasesExtraLimit,
      );
      const reassigned = withReassignedIds([...repoCard.evidence, ...additions], releaseEvidence, "E-RL-");
      additions.push(...reassigned);
      added.release += reassigned.length;
    } catch {
      // Best effort.
    }

    if (repoCard.root_files && repoCard.root_files.length > 0) {
      const rootEvidence = buildRootFilesEvidence(
        repoCard.full_name,
        repoCard.html_url,
        repoCard.root_files,
        fetchedAt,
      );
      const reassigned = withReassignedIds([...repoCard.evidence, ...additions], rootEvidence, "E-RF-");
      additions.push(...reassigned);
      added.root_files += reassigned.length;
    }

    const merged = dedupeEvidence([...repoCard.evidence, ...additions]);
    const updatedRepoCard: RepoCard = { ...repoCard, evidence: merged };

    emit?.({
      node: "repo_card_builder",
      repo: repoCard.full_name,
      level: "info",
      event: "GAP_ENRICH_OK",
      data: { iter: reason.iter, added, totalEvidence: merged.length },
    });

    return {
      updatedRepoCard,
      added,
      totalEvidence: merged.length,
    };
  } catch (error) {
    emit?.({
      node: "repo_card_builder",
      repo: repoCard.full_name,
      level: "warn",
      event: "GAP_ENRICH_FAIL",
      data: { iter: reason.iter, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
