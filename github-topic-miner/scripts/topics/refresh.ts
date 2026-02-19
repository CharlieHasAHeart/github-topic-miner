import { buildInitialPool } from "./build-initial-pool";
import { generateSeedPool } from "./generate-seed-pool";

export async function refreshTopics(): Promise<void> {
  await buildInitialPool();
  generateSeedPool();
}

if (require.main === module) {
  void refreshTopics();
}
