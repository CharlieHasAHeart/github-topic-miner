export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryOn: (err: unknown) => boolean;
  onRetry?: (meta: { attempt: number; error: unknown }) => void;
  onGiveup?: (meta: { attempt: number; error: unknown }) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(base: number, max: number, attempt: number, jitter: boolean): number {
  const raw = Math.min(max, base * Math.pow(2, attempt));
  if (!jitter) return raw;
  const delta = Math.floor(raw * 0.2);
  return raw - delta + Math.floor(Math.random() * (2 * delta + 1));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= opts.retries || !opts.retryOn(error)) {
        opts.onGiveup?.({ attempt: attempt + 1, error });
        throw error;
      }
      opts.onRetry?.({ attempt: attempt + 1, error });
      await sleep(backoff(opts.baseDelayMs, opts.maxDelayMs, attempt, opts.jitter));
    }
  }
  throw lastError;
}
