import type { MinerEvent } from "./types";

function truncate(value: string, maxChars = 200): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("api_key") ||
    normalized.includes("authorization") ||
    normalized.includes("token") ||
    normalized.includes("prompt") ||
    normalized === "readme_text" ||
    normalized.endsWith("_text")
  );
}

export function safeData(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const sanitize = (value: unknown, depth: number): unknown => {
    if (depth > 3) {
      return "[truncated-depth]";
    }
    if (typeof value === "string") {
      return truncate(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (isSensitiveKey(key)) {
          out[key] = "[redacted]";
          continue;
        }
        out[key] = sanitize(child, depth + 1);
      }
      return out;
    }
    return String(value);
  };

  return sanitize(input, 0) as Record<string, unknown>;
}

export function createLogger(runId: string): {
  log: (event: Omit<MinerEvent, "ts" | "run_id">) => void;
  getEvents: () => MinerEvent[];
} {
  const events: MinerEvent[] = [];

  return {
    log(event) {
      events.push({
        ts: new Date().toISOString(),
        run_id: runId,
        node: event.node,
        repo: event.repo ?? null,
        level: event.level,
        event: event.event,
        data: safeData(event.data),
      });
    },
    getEvents() {
      return [...events];
    },
  };
}
