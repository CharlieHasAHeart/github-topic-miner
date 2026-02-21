import { z } from "zod";

const CommandIOTypeSchema = z.string().regex(/^(string|boolean|int|float|timestamp|json)\??$/);
const CommandIOSchema = z
  .record(CommandIOTypeSchema)
  .refine((obj) => Object.keys(obj).length > 0, "command io must be non-empty object");

export const CanonicalSpecSchema = z.object({
  schema_version: z.literal(3),
  app: z.object({
    name: z.string().min(1),
    one_liner: z.string().min(1),
  }),
  screens: z.array(
    z.object({
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
      input: CommandIOSchema,
      output: CommandIOSchema,
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
          }),
        ),
      }),
    ),
  }),
  mvp_plan: z.array(z.string().min(1)),
  acceptance_tests: z.array(z.string()),
});

export type CanonicalSpec = z.infer<typeof CanonicalSpecSchema>;
