import type { ModelInfo, ProviderKind } from "./types";

/**
 * Provider presets. The first four are first-class SDK providers. The
 * OpenAI-compatible vendors (deepseek/qwen/minimax/kimi/openrouter/custom)
 * all ride ChatOpenAI with a preset base URL — a custom base URL overrides it.
 */
export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  /** Default model id used if the user hasn't picked one. */
  defaultModel: string;
  /** Env var consulted for an API key before falling back to stored key. */
  envKey: string;
  /** Placeholder shown in the API key field. */
  keyPlaceholder: string;
  /** Whether this provider speaks the OpenAI chat-completions shape. */
  openaiCompat: boolean;
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  anthropic: {
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "",
    defaultModel: "claude-sonnet-4-5",
    envKey: "ANTHROPIC_API_KEY",
    keyPlaceholder: "sk-ant-...",
    openaiCompat: false,
  },
  openai: {
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    envKey: "OPENAI_API_KEY",
    keyPlaceholder: "sk-...",
    openaiCompat: true,
  },
  ollama: {
    kind: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434",
    defaultModel: "llama3.1",
    envKey: "",
    keyPlaceholder: "No API key needed",
    openaiCompat: false,
  },
  deepseek: {
    kind: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
    keyPlaceholder: "sk-...",
    openaiCompat: true,
  },
  qwen: {
    kind: "qwen",
    label: "Qwen (Alibaba DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    envKey: "DASHSCOPE_API_KEY",
    keyPlaceholder: "sk-...",
    openaiCompat: true,
  },
  minimax: {
    kind: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    defaultModel: "MiniMax-Text-01",
    envKey: "MINIMAX_API_KEY",
    keyPlaceholder: "JWT / API key",
    openaiCompat: true,
  },
  kimi: {
    kind: "kimi",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-32k",
    envKey: "MOONSHOT_API_KEY",
    keyPlaceholder: "sk-...",
    openaiCompat: true,
  },
  openrouter: {
    kind: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    envKey: "OPENROUTER_API_KEY",
    keyPlaceholder: "sk-or-...",
    openaiCompat: true,
  },
  custom: {
    kind: "custom",
    label: "OpenAI-compatible (custom)",
    baseUrl: "",
    defaultModel: "",
    envKey: "OPENAI_API_KEY",
    keyPlaceholder: "API key (if required)",
    openaiCompat: true,
  },
};

/** Curated models surfaced in the model picker. */
export const MODEL_CATALOG: ModelInfo[] = [
  // Anthropic
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic", contextWindow: 200_000, vision: true, tools: true, recommended: true },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200_000, vision: true, tools: true, recommended: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", contextWindow: 200_000, vision: true, tools: true },
  // OpenAI
  { id: "gpt-4o", label: "GPT-4o", provider: "openai", contextWindow: 128_000, vision: true, tools: true },
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openai", contextWindow: 128_000, vision: true, tools: true },
  // Ollama
  { id: "llama3.1", label: "Llama 3.1", provider: "ollama", contextWindow: 128_000, vision: false, tools: true },
  { id: "qwen2.5", label: "Qwen 2.5", provider: "ollama", contextWindow: 128_000, vision: false, tools: true },
  // DeepSeek
  { id: "deepseek-chat", label: "DeepSeek Chat (V3)", provider: "deepseek", contextWindow: 64_000, vision: false, tools: true, recommended: true },
  { id: "deepseek-reasoner", label: "DeepSeek R1", provider: "deepseek", contextWindow: 64_000, vision: false, tools: true },
  // Qwen
  { id: "qwen-plus", label: "Qwen Plus", provider: "qwen", contextWindow: 131_072, vision: true, tools: true },
  { id: "qwen-max", label: "Qwen Max", provider: "qwen", contextWindow: 32_768, vision: true, tools: true },
  // MiniMax
  { id: "MiniMax-Text-01", label: "MiniMax Text 01", provider: "minimax", contextWindow: 1_000_000, vision: false, tools: true },
  // Kimi
  { id: "moonshot-v1-32k", label: "Moonshot v1 32K", provider: "kimi", contextWindow: 32_768, vision: false, tools: true },
  { id: "moonshot-v1-128k", label: "Moonshot v1 128K", provider: "kimi", contextWindow: 128_000, vision: false, tools: true },
];

/** Best-effort capability lookup for an arbitrary model id (custom/uncurated). */
export function modelCapabilities(modelId: string): { vision: boolean; contextWindow: number } {
  const lower = modelId.toLowerCase();
  const exact = MODEL_CATALOG.find((m) => m.id === modelId);
  if (exact) return { vision: exact.vision, contextWindow: exact.contextWindow };
  const hasVision = /(vision|gpt-4o|claude|opus|sonnet|haiku|qwen-(plus|max|vl)|gemini|multimodal)/i.test(lower);
  let contextWindow = 128_000;
  if (/1m|million/.test(lower)) contextWindow = 1_000_000;
  else if (/200k/.test(lower)) contextWindow = 200_000;
  else if (/128k/.test(lower)) contextWindow = 128_000;
  else if (/32k/.test(lower)) contextWindow = 32_768;
  return { vision: hasVision, contextWindow };
}

export function modelsForProvider(provider: ProviderKind): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}
