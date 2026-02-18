import type { EvidenceItem, RepoCard } from "../types";

function pickByType(evidence: EvidenceItem[], type: EvidenceItem["type"], limit: number): EvidenceItem[] {
  return evidence.filter((item) => item.type === type).slice(0, limit);
}

function detectSchemaLikeFiles(rootFiles: string[]): boolean {
  const keys = ["db", "sql", "schema", "migration", "sqlite", "prisma"];
  return rootFiles.some((name) => keys.some((k) => name.toLowerCase().includes(k)));
}

function issueLooksLikeCommandOrTest(text: string): boolean {
  const keys = ["bug", "crash", "export", "import", "sync", "save", "load", "fail", "error"];
  const lower = text.toLowerCase();
  return keys.some((k) => lower.includes(k));
}

export function buildCitationHints(repoCard: RepoCard, selectedEvidence: EvidenceItem[]): string {
  const readme = pickByType(selectedEvidence, "readme", 3).map((x) => x.id);
  const issues = pickByType(selectedEvidence, "issue", 8)
    .filter((x) => issueLooksLikeCommandOrTest(`${x.title} ${x.excerpt}`))
    .slice(0, 4)
    .map((x) => x.id);
  const releases = pickByType(selectedEvidence, "release", 2).map((x) => x.id);
  const root = pickByType(selectedEvidence, "root_files", 1).map((x) => x.id);

  const rootFiles = repoCard.root_files ?? [];
  const schemaBoost = detectSchemaLikeFiles(rootFiles);

  const appCore = [...new Set([...readme, ...releases])].slice(0, 4);
  const commands = [...new Set([...issues, ...readme.slice(0, 1), ...root])].slice(0, 4);
  const tables = [...new Set([...readme.slice(0, 2), ...(schemaBoost ? root : []), ...issues.slice(0, 1)])].slice(0, 4);
  const tests = [...new Set([...issues, ...releases, ...readme.slice(0, 1)])].slice(0, 4);

  return [
    `Suggested for app/core_loop: ${appCore.join(", ") || "(use any closest readme evidence)"}`,
    `Suggested for commands: ${commands.join(", ") || "(use issue/release evidence)"}`,
    `Suggested for tables: ${tables.join(", ") || "(use readme/root_files evidence)"}`,
    `Suggested for acceptance_tests: ${tests.join(", ") || "(use issues/readme evidence)"}`,
  ].join("\n");
}
