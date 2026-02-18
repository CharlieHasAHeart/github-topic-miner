import { z } from "zod";

const EvidenceIds = z.array(z.string());
const RecordIds = z.record(EvidenceIds);

export const CitationsPatchSchema = z
  .object({
    app: EvidenceIds.optional(),
    core_loop: EvidenceIds.optional(),
    screens: RecordIds.optional(),
    commands: RecordIds.optional(),
    tables: RecordIds.optional(),
    acceptance_tests: RecordIds.optional(),
  })
  .strict();

export type CitationsPatch = z.infer<typeof CitationsPatchSchema>;
