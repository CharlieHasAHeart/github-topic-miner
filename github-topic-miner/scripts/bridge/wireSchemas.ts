import { z } from "zod";

const StringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);
const EvidenceIdsSchema = z.array(z.string());

const ScreenSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  purpose: z.string().optional(),
  primary_actions: z.array(z.string()).optional(),
});

const CommandSchema = z.object({
  name: z.string().optional(),
  purpose: z.string().optional(),
  async: z.boolean().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});

const FieldSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  notes: z.string().optional(),
});

const TableSchema = z.object({
  name: z.string().optional(),
  fields: z.array(FieldSchema).optional(),
  indexes: z.array(z.string()).optional(),
});

const MapCitationsSchema = z.object({
  app: EvidenceIdsSchema.optional(),
  core_loop: EvidenceIdsSchema.optional(),
  screens: z.record(EvidenceIdsSchema).optional(),
  commands: z.record(EvidenceIdsSchema).optional(),
  tables: z.record(EvidenceIdsSchema).optional(),
  acceptance_tests: z.record(EvidenceIdsSchema).optional(),
});

const ListCitationsSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      evidence_ids: EvidenceIdsSchema,
    }),
  ),
});

export const WireSpecSchema = z
  .object({
    meta: z
      .object({
        source_repo: z
          .object({
            full_name: z.string().optional(),
            url: z.string().optional(),
          })
          .optional(),
        topics: z.array(z.string()).optional(),
      })
      .optional(),
    app: z
      .object({
        name: z.string().optional(),
        one_sentence: z.string().optional(),
        inspired_by: z.union([z.string(), z.null()]).optional(),
      })
      .optional(),
    core_loop: z.string().optional(),
    screens: z.array(z.union([z.string(), ScreenSchema])).optional(),
    rust_commands: z.array(z.union([z.string(), CommandSchema])).optional(),
    data_model: z
      .object({
        tables: z.array(z.union([z.string(), TableSchema])).optional(),
      })
      .optional(),
    mvp_plan: z
      .object({
        milestones: z
          .array(
            z.object({
              week: z.union([z.number(), z.string()]).optional(),
              tasks: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    acceptance_tests: z.array(z.union([z.string(), z.object({ test: z.string().optional() })])).optional(),
    open_questions: z.array(z.string()).optional(),
    scores: z
      .object({
        closure: z.union([z.number(), z.string()]).optional(),
        feasibility: z.union([z.number(), z.string()]).optional(),
        stack_fit: z.union([z.number(), z.string()]).optional(),
        complexity_control: z.union([z.number(), z.string()]).optional(),
        debuggability: z.union([z.number(), z.string()]).optional(),
        demo_value: z.union([z.number(), z.string()]).optional(),
      })
      .optional(),
    overall_recommendation: z.string().optional(),
    citations: z.union([MapCitationsSchema, ListCitationsSchema, z.record(z.unknown()), z.array(z.unknown())]).optional(),
    tauri_capabilities: z.array(z.union([z.string(), StringOrStringArraySchema])).optional(),
  })
  .passthrough();

export type WireSpec = z.infer<typeof WireSpecSchema>;
