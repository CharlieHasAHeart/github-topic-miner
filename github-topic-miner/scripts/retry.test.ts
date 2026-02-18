import assert from "node:assert/strict";
import { withRetry } from "./retry";

async function run() {
  let attemptsRetriable = 0;
  const value = await withRetry(
    async () => {
      attemptsRetriable += 1;
      if (attemptsRetriable < 3) {
        const err = new Error("temporary");
        (err as Error & { status?: number }).status = 500;
        throw err;
      }
      return "ok";
    },
    {
      retries: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      jitter: false,
      retryOn: (err) => ((err as { status?: number }).status ?? 0) >= 500,
    },
  );
  assert.equal(value, "ok");
  assert.equal(attemptsRetriable, 3);

  let attemptsNonRetriable = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attemptsNonRetriable += 1;
          const err = new Error("forbidden");
          (err as Error & { status?: number }).status = 403;
          throw err;
        },
        {
          retries: 3,
          baseDelayMs: 1,
          maxDelayMs: 2,
          jitter: false,
          retryOn: (err) => ((err as { status?: number }).status ?? 0) >= 500,
        },
      ),
    /forbidden/,
  );
  assert.equal(attemptsNonRetriable, 1);
}

void run().then(() => console.log("retry.test.ts passed"));
