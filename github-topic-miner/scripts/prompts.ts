import type { EvidenceItem, RepoCard } from "./types";
import { buildCitationHints } from "./bridge/hints";
import { safeExcerpt, selectEvidenceForLLM } from "./evidence";

function compactRepoCard(repoCard: RepoCard): object {
  return {
    full_name: repoCard.full_name,
    html_url: repoCard.html_url,
    description: repoCard.description,
    topics: repoCard.topics,
    language: repoCard.language,
    stargazers_count: repoCard.stargazers_count,
    forks_count: repoCard.forks_count,
    open_issues_count: repoCard.open_issues_count,
    default_branch: repoCard.default_branch,
    pushed_at: repoCard.pushed_at,
    readme: {
      fetched: repoCard.readme.fetched,
      truncated: repoCard.readme.truncated,
      source: repoCard.readme.source,
      bytes: repoCard.readme.bytes ?? null,
    },
    releases_count: repoCard.releases.items.length,
    issues_count: repoCard.issues.items.length,
    root_files_count: repoCard.root_files?.length ?? 0,
  };
}

export function selectEvidenceForPrompt(evidence: EvidenceItem[]): EvidenceItem[] {
  return selectEvidenceForLLM(evidence, 30);
}

export function evidenceLinesForPrompt(evidence: EvidenceItem[]): string[] {
  return selectEvidenceForPrompt(evidence).map((item) => {
    return `[ID:${item.id}] (${item.type}) TITLE="${safeExcerpt(item.title, 160)}" URL=${item.source_url} EXCERPT="${safeExcerpt(item.excerpt, 900)}"`;
  });
}

function evidenceIdPool(evidence: EvidenceItem[]): string[] {
  return selectEvidenceForPrompt(evidence).map((item) => item.id);
}

export function buildWireSynthPrompts(repoCard: RepoCard): {
  systemPrompt: string;
  userPrompt: string;
} & {
  selectedEvidenceIds: string[];
} {
  const selectedEvidence = selectEvidenceForPrompt(repoCard.evidence);
  const allowedEvidenceIds = evidenceIdPool(selectedEvidence);
  const citationHints = buildCitationHints(repoCard, selectedEvidence);

  return {
    systemPrompt: [
      "You are Synthesizer for WireSpec generation.",
      "Output must be valid JSON only. No markdown, no explanations.",
      "You output WireSpec, but citations MUST be canonical map shape.",
      "Do NOT output schema_version/meta.run_id/meta.generated_at.",
      "Citations coverage is mandatory: app, core_loop, screens by each screen.id, commands by each rust_commands.name, tables by each table name, acceptance_tests by each index string.",
      "Every citations value MUST be a non-empty evidence_ids array.",
      "Every evidence id MUST be copied exactly from allowedEvidenceIds list. Never invent IDs.",
      "If evidence seems weak, still choose the closest allowed evidence id; do not leave empty arrays.",
      "overall_recommendation MUST be go or hold only.",
    ].join(" "),
    userPrompt: JSON.stringify(
      {
        task: "Produce a WireSpec JSON from repository evidence with canonical-like citations map.",
        allowedEvidenceIds,
        allowedEvidenceIds_display: allowedEvidenceIds.map((id) => `[ID:${id}]`),
        evidence_lines: evidenceLinesForPrompt(selectedEvidence),
        citation_hints: citationHints,
        evidence_strategy: [
          "Prefer readme evidence for app/core_loop/screens/tables.",
          "Use issues/releases as supporting evidence for commands and acceptance_tests.",
          "If unsure, pick closest allowed evidence id; never leave citation arrays empty.",
        ],
        repo_profile: compactRepoCard(repoCard),
        output_template: {
          app: { name: "string", one_sentence: "string", inspired_by: null },
          core_loop: "string",
          screens: [{ id: "main", name: "string", purpose: "string", primary_actions: ["string"] }],
          rust_commands: [{ name: "save_item", purpose: "string", async: true, input: {}, output: {} }],
          data_model: { tables: [{ name: "string", fields: [{ name: "string", type: "string" }] }] },
          mvp_plan: { milestones: [{ week: 1, tasks: ["string"] }] },
          acceptance_tests: ["string"],
          open_questions: ["string"],
          scores: {
            closure: 3,
            feasibility: 3,
            stack_fit: 3,
            complexity_control: 3,
            debuggability: 3,
            demo_value: 3,
          },
          overall_recommendation: "go",
          citations: {
            app: ["EV::RD::0001"],
            core_loop: ["EV::RD::0001"],
            screens: { main: ["EV::RD::0001"], settings: ["EV::IS::0001"] },
            commands: { save_item: ["EV::IS::0001"], list_items: ["EV::RL::0001"] },
            tables: { items: ["EV::RD::0002"] },
            acceptance_tests: { "0": ["EV::IS::0002"], "1": ["EV::RD::0003"] },
          },
        },
        template_note:
          "Template ids above are placeholders only. In real output you MUST copy ids from allowedEvidenceIds.",
      },
      null,
      2,
    ),
    selectedEvidenceIds: allowedEvidenceIds,
  };
}
