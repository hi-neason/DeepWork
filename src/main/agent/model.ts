import { ChatAnthropic } from "@langchain/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getApiKey } from "../storage/settings";
import { PROVIDER_PRESETS } from "../../shared/providers";
import type { ModelConfig, ProviderKind, VerifyResult } from "../../shared/types";

/**
 * Resolve credentials/endpoint with this precedence (highest first):
 *   1. values the user entered in DeepWork settings (stored encrypted)
 *   2. standard environment variables (shared with Claude Code / Anthropic SDK)
 *
 * No secret is ever hardcoded here. We only read process.env at runtime.
 */
function resolveAnthropic(cfg: ModelConfig): ConstructorParameters<typeof ChatAnthropic>[0] {
  const apiKey = getApiKey("anthropic") || process.env.ANTHROPIC_API_KEY || undefined;
  // ANTHROPIC_AUTH_TOKEN is a bearer token (used by Anthropic-compatible gateways
  // like Volcengine Ark). It is sent as `Authorization: Bearer <token>`.
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || undefined;
  const baseUrl = cfg.baseUrl || process.env.ANTHROPIC_BASE_URL || undefined;
  // If the CC-style env vars are present they win over the stored default model.
  const model = process.env.ANTHROPIC_MODEL || cfg.model || "claude-sonnet-4-5";

  const options: ConstructorParameters<typeof ChatAnthropic>[0] = {
    model,
    maxRetries: 2,
    ...(baseUrl ? { anthropicApiUrl: baseUrl } : {}),
  };

  const timeoutMs = process.env.API_TIMEOUT_MS
    ? Number(process.env.API_TIMEOUT_MS)
    : undefined;
  const clientTimeout = timeoutMs ? { timeout: timeoutMs } : {};

  if (authToken) {
    options.createClient = (clientOptions) =>
      new Anthropic({
        ...clientOptions,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        authToken,
        ...clientTimeout,
      });
  } else if (apiKey) {
    options.apiKey = apiKey;
    if (timeoutMs) options.clientOptions = clientTimeout;
  }
  return options;
}

function resolveOpenAICompat(provider: ProviderKind, cfg: ModelConfig): ConstructorParameters<typeof ChatOpenAI>[0] {
  const preset = PROVIDER_PRESETS[provider];
  const apiKey = getApiKey(provider) || (preset.envKey ? process.env[preset.envKey] : "") || undefined;
  const baseUrl = cfg.baseUrl || preset.baseUrl || undefined;
  return {
    model: cfg.model || preset.defaultModel,
    apiKey: apiKey ?? "not-needed",
    configuration: baseUrl ? { baseURL: baseUrl } : undefined,
    maxRetries: 2,
  };
}

export function createChatModel(cfg: ModelConfig): BaseChatModel {
  switch (cfg.provider) {
    case "anthropic":
      return new ChatAnthropic(resolveAnthropic(cfg));
    case "ollama":
      return new ChatOllama({
        model: cfg.model || PROVIDER_PRESETS.ollama.defaultModel,
        baseUrl: cfg.baseUrl || PROVIDER_PRESETS.ollama.baseUrl,
      });
    case "openai":
    case "deepseek":
    case "qwen":
    case "minimax":
    case "kimi":
    case "openrouter":
    case "custom":
      return new ChatOpenAI(resolveOpenAICompat(cfg.provider, cfg));
  }
}

/**
 * Verify a provider key by making a cheap read-only call. For OpenAI-compatible
 * providers we hit /models; for Ollama we hit /api/tags; for Anthropic we list
 * models via the SDK. Failures are returned, not thrown.
 */
export async function verifyModelConfig(cfg: ModelConfig): Promise<VerifyResult> {
  try {
    if (cfg.provider === "ollama") {
      const base = (cfg.baseUrl || PROVIDER_PRESETS.ollama.baseUrl).replace(/\/$/, "");
      const res = await fetch(base + "/api/tags", { method: "GET" });
      if (!res.ok) return { ok: false, message: `Ollama returned ${res.status}` };
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return {
        ok: true,
        message: "Connected to Ollama",
        models: (data.models ?? []).map((m) => m.name),
      };
    }

    if (cfg.provider === "anthropic") {
      const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
      const key = authToken || getApiKey("anthropic") || process.env.ANTHROPIC_API_KEY;
      if (!key) return { ok: false, message: "No API key configured" };
      const base = cfg.baseUrl || process.env.ANTHROPIC_BASE_URL;
      const headers: Record<string, string> = {
        "anthropic-version": "2023-06-01",
        ...(authToken
          ? { Authorization: `Bearer ${authToken}` }
          : { "x-api-key": key }),
      };
      const url = (base ? base.replace(/\/$/, "") : "https://api.anthropic.com") + "/v1/models?limit=5";
      const res = await fetch(url, { headers });
      if (!res.ok) return { ok: false, message: `Anthropic returned ${res.status}: ${await res.text().catch(() => "")}` };
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return {
        ok: true,
        message: "Anthropic key verified",
        models: (data.data ?? []).map((m) => m.id),
      };
    }

    // OpenAI-compatible providers.
    const preset = PROVIDER_PRESETS[cfg.provider];
    const key = getApiKey(cfg.provider) || (preset.envKey ? process.env[preset.envKey] ?? "" : "");
    if (!key && cfg.provider !== "custom") {
      return { ok: false, message: "No API key configured" };
    }
    const base = (cfg.baseUrl || preset.baseUrl).replace(/\/$/, "");
    if (!base) return { ok: false, message: "A Base URL is required for this provider" };
    const res = await fetch(base + "/models", {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) return { ok: false, message: `Provider returned ${res.status}: ${await res.text().catch(() => "")}` };
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return {
      ok: true,
      message: `${preset.label} key verified`,
      models: (data.data ?? []).map((m) => m.id),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
