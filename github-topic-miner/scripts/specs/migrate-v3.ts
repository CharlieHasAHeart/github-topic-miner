import fs from "node:fs";
import path from "node:path";
import { CanonicalSpecSchema } from "../bridge/canonicalSchemas";
import { normalizeWireToCanonical } from "../bridge/normalize";

function isDateDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function collectSpecFiles(specsRoot: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(specsRoot)) return out;
  for (const entry of fs.readdirSync(specsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isDateDir(entry.name)) continue;
    const dir = path.join(specsRoot, entry.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      out.push(path.join(dir, file.name));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function migrateOne(filePath: string): { changed: boolean; fixes: string[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const normalized = normalizeWireToCanonical({
    wire: parsed as any,
    run_id: typeof parsed?.meta?.run_id === "string" ? parsed.meta.run_id : "migrated",
    generated_at:
      typeof parsed?.meta?.generated_at === "string" ? parsed.meta.generated_at : "1970-01-01T00:00:00.000Z",
    source_repo:
      parsed?.meta?.source_repo &&
      typeof parsed.meta.source_repo === "object" &&
      typeof parsed.meta.source_repo.full_name === "string" &&
      typeof parsed.meta.source_repo.url === "string"
        ? parsed.meta.source_repo
        : { full_name: "unknown/unknown", url: "https://github.com/unknown/unknown" },
    topics: Array.isArray(parsed?.meta?.topics) ? parsed.meta.topics.filter((x: unknown): x is string => typeof x === "string") : [],
  });
  const canonical = CanonicalSpecSchema.parse(normalized.canonical);
  const next = `${JSON.stringify(canonical, null, 2)}\n`;
  const changed = next !== raw;
  if (changed) fs.writeFileSync(filePath, next, "utf8");
  return { changed, fixes: normalized.normalize_report.fixes };
}

function run() {
  const repoRoot = process.cwd();
  const specsRoot = path.join(repoRoot, "specs");
  const files = collectSpecFiles(specsRoot);
  let changed = 0;
  for (const file of files) {
    const result = migrateOne(file);
    if (result.changed) changed += 1;
  }
  console.log(`specs migrate complete: files=${files.length}, changed=${changed}`);
}

run();
