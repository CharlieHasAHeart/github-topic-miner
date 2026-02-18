import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { repoEndpointCacheKey } from "./cache";
import { fetchRecentIssues } from "./github";

function removeCache(key: string) {
  const abs = path.resolve(process.cwd(), "cache", "github", key);
  try {
    rmSync(abs);
  } catch {
    // ignore
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run() {
  const originalFetch = global.fetch;
  try {
    const repo500 = "test-owner/repo-500";
    const key500 = repoEndpointCacheKey(repo500, "issues_10");
    removeCache(key500);
    let calls500 = 0;
    let retryEvents500 = 0;
    global.fetch = (async () => {
      calls500 += 1;
      if (calls500 === 1) return jsonResponse({ message: "server err" }, 500);
      return jsonResponse([{ number: 1, title: "issue", state: "open", html_url: "https://x/y" }], 200);
    }) as typeof fetch;
    const issues = await fetchRecentIssues(repo500, undefined, 10, {
      onRetryEvent: (event) => {
        if (event === "GITHUB_RETRY") retryEvents500 += 1;
      },
    });
    assert.equal(issues.length, 1);
    assert.ok(calls500 >= 2);
    assert.ok(retryEvents500 >= 1);

    const repo403 = "test-owner/repo-403";
    const key403 = repoEndpointCacheKey(repo403, "issues_10");
    removeCache(key403);
    let calls403 = 0;
    let retryEvents403 = 0;
    global.fetch = (async () => {
      calls403 += 1;
      return jsonResponse({ message: "forbidden" }, 403);
    }) as typeof fetch;
    await assert.rejects(
      () =>
        fetchRecentIssues(repo403, undefined, 10, {
          onRetryEvent: (event) => {
            if (event === "GITHUB_RETRY") retryEvents403 += 1;
          },
        }),
      /403/,
    );
    assert.equal(calls403, 1);
    assert.equal(retryEvents403, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

void run().then(() => console.log("github.retry.test.ts passed"));
