import { ChatAnthropic } from "@langchain/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getApiKey } from "../storage/settings";
import type { ModelConfig } from "../../shared/types";

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
  const baseUrl =
    cfg.baseUrl || process.env.ANTHROPIC_BASE_URL || undefined;
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
    // The LangChain ChatAnthropic wrapper requires an apiKey field, but we are
    // using a bearer token (ANTHROPIC_AUTH_TOKEN, e.g. for an Anthropic-compatible
    // gateway). Construct the underlying SDK client directly so it uses bearer
    // auth and no X-Api-Key header is sent.
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

export function createChatModel(cfg: ModelConfig): BaseChatModel {
  switch (cfg.provider) {
    case "anthropic":
      return new ChatAnthropic(resolveAnthropic(cfg));
    case "openai":
      return new ChatOpenAI({
        model: cfg.model,
        apiKey: getApiKey("openai") || process.env.OPENAI_API_KEY || undefined,
        configuration: cfg.baseUrl ? { baseURL: cfg.baseUrl } : undefined,
        maxRetries: 2,
      });
    case "ollama":
      return new ChatOllama({
        model: cfg.model,
        baseUrl: cfg.baseUrl || "http://localhost:11434",
      });
  }
}
