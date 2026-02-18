import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE_ROOT = path.resolve(process.cwd(), "cache", "github");

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function repoEndpointCacheKey(repoFullName: string, endpoint: string): string {
  const repo = sanitize(repoFullName.replace("/", "__"));
  return path.join(repo, `${sanitize(endpoint)}.json`);
}

export function getCache(key: string): { hit: boolean; data?: unknown } {
  const abs = path.join(CACHE_ROOT, key);
  if (!existsSync(abs)) return { hit: false };
  try {
    return { hit: true, data: JSON.parse(readFileSync(abs, "utf-8")) };
  } catch {
    return { hit: false };
  }
}

export function setCache(key: string, data: unknown): void {
  const abs = path.join(CACHE_ROOT, key);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
