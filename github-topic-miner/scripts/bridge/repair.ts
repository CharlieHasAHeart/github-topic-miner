import { chatJSONRaw } from "../llm";
import { CitationsPatchSchema, type CitationsPatch } from "./patchSchemas";

interface RepairCitationsWithPatchParams {
  repo: string;
  iter?: number;
  attempt: number;
  missingKeys: string[];
  allowedEvidenceIds: string[];
  evidenceLines: string[];
  provider?: "openai" | "anthropic" | "gemini" | "qwen" | "deepseek";
  model: string;
  temperature: number;
  run_id: string;
  onAudit?: (audit: unknown) => void;
  onEvent?: (event: string, data?: Record<string, unknown>) => void;
}

function extractFirstJsonValue(text: string): unknown {
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) throw new Error("No JSON object found in repair patch response");
  return JSON.parse(text.slice(firstBrace));
}

export async function repairCitationsWithPatch(
  params: RepairCitationsWithPatchParams,
): Promise<{ patch: CitationsPatch; raw: string }> {
  params.onEvent?.("REPAIR_PATCH_START", {
    repo: params.repo,
    iter: params.iter,
    attempt: params.attempt,
    missing_keys_count: params.missingKeys.length,
  });

  const systemPrompt = [
    "You are a citation patch generator.",
    "Output JSON only.",
    "Output must match this strict shape: {app?,core_loop?,screens?,commands?,tables?,acceptance_tests?}.",
    "Do not output any business fields. Do not rewrite app/core_loop text/screens/commands/tables/tests.",
    "Only include keys that correspond to missingKeys provided by user.",
    "For each included key, provide one or more evidence ids copied exactly from allowedEvidenceIds.",
    "Never invent ids and never output explanations.",
  ].join(" ");

  const userPrompt = JSON.stringify(
    {
      task: "Generate minimal citations patch for missing keys only.",
      missingKeys: params.missingKeys,
      allowedEvidenceIds: params.allowedEvidenceIds,
      evidence_lines: params.evidenceLines,
      output_example: {
        app: ["E-RD-001"],
        commands: { save_item: ["E-IS-003"] },
        acceptance_tests: { "0": ["E-IS-002"] },
      },
    },
    null,
    2,
  );

  try {
    const raw = await chatJSONRaw({
      systemPrompt,
      userPrompt,
      provider: params.provider,
      model: params.model,
      temperature: params.temperature,
      audit: {
        run_id: params.run_id,
        repo: params.repo,
        iter: params.iter,
        role: "repair_patch",
        input_stats: {
          evidence_count: params.allowedEvidenceIds.length,
          approx_chars: systemPrompt.length + userPrompt.length,
        },
        onAudit: (audit) => {
          if (params.onAudit) {
            const enhanced = {
              ...(audit as unknown as Record<string, unknown>),
              missing_keys_count: params.missingKeys.length,
            };
            params.onAudit(enhanced);
          }
        },
      },
    });
    const parsed = extractFirstJsonValue(raw.content);
    const patch = CitationsPatchSchema.parse(parsed);
    params.onEvent?.("REPAIR_PATCH_OK", {
      repo: params.repo,
      iter: params.iter,
      attempt: params.attempt,
      missing_keys_count: params.missingKeys.length,
    });
    return { patch, raw: raw.content };
  } catch (error) {
    params.onEvent?.("REPAIR_PATCH_FAIL", {
      repo: params.repo,
      iter: params.iter,
      attempt: params.attempt,
      missing_keys_count: params.missingKeys.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
