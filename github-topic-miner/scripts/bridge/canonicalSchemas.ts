import { z } from "zod";

const EvidenceIdsSchema = z.array(z.string());

export const CanonicalSpecSchema = z.object({
  schema_version: z.literal(2),
  meta: z.object({
    run_id: z.string().min(1),
    generated_at: z.string().min(1),
    source_repo: z.object({
      full_name: z.string().min(1),
      url: z.string().min(1),
    }),
    topics: z.array(z.string()),
  }),
  app: z.object({
    name: z.string().min(1),
    one_liner: z.string().min(1),
    inspired_by: z.string().nullable(),
  }),
  core_loop: z.string().min(1),
  screens: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      purpose: z.string().min(1),
      primary_actions: z.array(z.string().min(1)),
    }),
  ),
  rust_commands: z.array(
    z.object({
      name: z.string().min(1),
      purpose: z.string().min(1),
      async: z.boolean(),
      input: z.unknown(),
      output: z.unknown(),
    }),
  ),
  data_model: z.object({
    tables: z.array(
      z.object({
        name: z.string().min(1),
        columns: z.array(
          z.object({
            name: z.string().min(1),
            type: z.string().min(1),
            notes: z.string().optional(),
          }),
        ),
        indexes: z.array(z.string()).optional(),
      }),
    ),
  }),
  tauri_capabilities: z.array(z.string()),
  // Forge-compatible: flattened plan steps
  mvp_plan: z.array(z.string().min(1)),
  acceptance_tests: z.array(z.string()),
  open_questions: z.array(z.string()),
  scores: z.object({
    closure: z.number().int().min(0).max(5),
    feasibility: z.number().int().min(0).max(5),
    stack_fit: z.number().int().min(0).max(5),
    complexity_control: z.number().int().min(0).max(5),
    debuggability: z.number().int().min(0).max(5),
    demo_value: z.number().int().min(0).max(5),
  }),
  overall_recommendation: z.enum(["go", "hold"]),
  citations: z.object({
    app: EvidenceIdsSchema,
    core_loop: EvidenceIdsSchema,
    screens: z.record(EvidenceIdsSchema),
    commands: z.record(EvidenceIdsSchema),
    tables: z.record(EvidenceIdsSchema),
    acceptance_tests: z.record(EvidenceIdsSchema),
  }),
});

export type CanonicalSpec = z.infer<typeof CanonicalSpecSchema>;
