import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getApiKey } from "../storage/settings";
import type { ModelConfig } from "../../shared/types";

export function createChatModel(cfg: ModelConfig): BaseChatModel {
  switch (cfg.provider) {
    case "anthropic":
      return new ChatAnthropic({
        model: cfg.model,
        apiKey: getApiKey("anthropic"),
        maxRetries: 2,
      });
    case "openai":
      return new ChatOpenAI({
        model: cfg.model,
        apiKey: getApiKey("openai"),
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
