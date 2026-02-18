import { createHash } from "node:crypto";
import type { LlmAudit } from "./types";

type LLMProvider = "openai" | "anthropic" | "gemini" | "qwen" | "deepseek";

interface ChatJSONRawParams {
  systemPrompt: string;
  userPrompt: string;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  audit?: {
    run_id: string;
    repo?: string | null;
    iter?: number;
    role: string;
    input_stats?: {
      evidence_count?: number;
      approx_chars?: number;
    };
    onAudit?: (audit: LlmAudit) => void;
  };
}

interface ProviderRuntimeConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
}

function extractContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function resolveProvider(input?: LLMProvider): LLMProvider {
  const envProvider = process.env.LLM_PROVIDER?.toLowerCase();
  if (
    envProvider === "openai" ||
    envProvider === "anthropic" ||
    envProvider === "gemini" ||
    envProvider === "qwen" ||
    envProvider === "deepseek"
  ) {
    return envProvider;
  }
  return input ?? "openai";
}

function resolveProviderRuntimeConfig(params: {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}): ProviderRuntimeConfig {
  const provider = resolveProvider(params.provider);
  const temperature = params.temperature ?? 0.2;
  const normalizeBase = (base: string): string => base.replace(/\/+$/, "");

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required when provider=openai.");
    return {
      provider,
      apiKey,
      baseUrl: normalizeBase(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
      model: process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? params.model ?? "gpt-4o-mini",
      temperature,
    };
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required when provider=anthropic.");
    return {
      provider,
      apiKey,
      baseUrl: normalizeBase(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"),
      model:
        process.env.ANTHROPIC_MODEL ?? process.env.LLM_MODEL ?? params.model ?? "claude-3-5-sonnet-latest",
      temperature,
    };
  }

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when provider=gemini.");
    return {
      provider,
      apiKey,
      baseUrl: normalizeBase(process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta"),
      model: process.env.GEMINI_MODEL ?? process.env.LLM_MODEL ?? params.model ?? "gemini-1.5-pro",
      temperature,
    };
  }

  if (provider === "qwen") {
    const apiKey = process.env.QWEN_API_KEY;
    if (!apiKey) throw new Error("QWEN_API_KEY is required when provider=qwen.");
    return {
      provider,
      apiKey,
      baseUrl: normalizeBase(process.env.QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"),
      model: process.env.QWEN_MODEL ?? process.env.LLM_MODEL ?? params.model ?? "qwen3-max-2026-01-23",
      temperature,
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required when provider=deepseek.");
  return {
    provider,
    apiKey,
    baseUrl: normalizeBase(process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1"),
    model: process.env.DEEPSEEK_MODEL ?? process.env.LLM_MODEL ?? params.model ?? "deepseek-chat",
    temperature,
  };
}

async function callOpenAICompatible(config: ProviderRuntimeConfig, systemPrompt: string, userPrompt: string) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: [
        { role: "system", content: `${systemPrompt}\nOutput JSON only.` },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM HTTP ${response.status} ${response.statusText}: ${body}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = extractContent(data.choices?.[0]?.message?.content ?? "");
  if (!content) throw new Error("LLM returned empty content.");
  return content;
}

async function callAnthropic(config: ProviderRuntimeConfig, systemPrompt: string, userPrompt: string) {
  const response = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      temperature: config.temperature,
      system: `${systemPrompt}\nOutput JSON only.`,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM HTTP ${response.status} ${response.statusText}: ${body}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = (data.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  if (!content) throw new Error("LLM returned empty content.");
  return content;
}

async function callGemini(config: ProviderRuntimeConfig, systemPrompt: string, userPrompt: string) {
  const url = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n${userPrompt}\n\nOutput JSON only.` }],
        },
      ],
      generationConfig: { temperature: config.temperature },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM HTTP ${response.status} ${response.statusText}: ${body}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const content = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  if (!content) throw new Error("LLM returned empty content.");
  return content;
}

async function callProvider(config: ProviderRuntimeConfig, systemPrompt: string, userPrompt: string) {
  if (config.provider === "anthropic") return callAnthropic(config, systemPrompt, userPrompt);
  if (config.provider === "gemini") return callGemini(config, systemPrompt, userPrompt);
  return callOpenAICompatible(config, systemPrompt, userPrompt);
}

export async function chatJSONRaw(
  params: ChatJSONRawParams,
): Promise<{
  content: string;
  usageApprox: { promptChars: number; completionChars: number };
}> {
  const startedAt = Date.now();
  const config = resolveProviderRuntimeConfig({
    provider: params.provider,
    model: params.model,
    temperature: params.temperature,
  });
  const promptHash = createHash("sha256")
    .update(params.systemPrompt)
    .update("\n\n")
    .update(params.userPrompt)
    .digest("hex");

  let retryCount = 0;

  const promptChars = params.systemPrompt.length + params.userPrompt.length;
  const emitAudit = (errorMessage?: string, completionChars = 0) => {
    if (!params.audit?.onAudit) return;
    params.audit.onAudit({
      ts: new Date().toISOString(),
      run_id: params.audit.run_id,
      repo: params.audit.repo ?? null,
      iter: params.audit.iter,
      role: params.audit.role,
      model: config.model,
      temperature: config.temperature,
      prompt_hash: promptHash,
      input_stats: {
        evidence_count: params.audit.input_stats?.evidence_count ?? 0,
        approx_chars:
          params.audit.input_stats?.approx_chars ?? params.systemPrompt.length + params.userPrompt.length,
      },
      output_stats: {
        json_parse_ok: false,
        schema_ok: false,
        unknown_evidence_ids_count: 0,
      },
      correction_retry: false,
      retry_count: retryCount,
      duration_ms: Date.now() - startedAt,
      prompt_chars: promptChars,
      completion_chars: completionChars,
      ...(errorMessage ? { error: errorMessage.slice(0, 200) } : {}),
    });
  };

  try {
    const content = await callProvider(config, params.systemPrompt, params.userPrompt);
    emitAudit(undefined, content.length);
    return { content, usageApprox: { promptChars, completionChars: content.length } };
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    retryCount = 0;
    emitAudit(reason.message, 0);
    throw reason;
  }
}
