import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { NextRequest } from "next/server";
import OpenAI from "openai";

// Any OpenAI-compatible endpoint can drive the Rescue Copilot. Ollama (local,
// keyless) is the default; set COPILOT_LLM_PROVIDER=groq or openai to use a hosted model.
const PROVIDERS = {
  ollama: { baseURL: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1", key: "ollama", model: "llama3.2:3b" },
  groq: { baseURL: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, model: "llama-3.3-70b-versatile" },
  openai: { baseURL: undefined, key: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" },
} as const;

const provider = PROVIDERS[(process.env.COPILOT_LLM_PROVIDER ?? "ollama") as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;

const serviceAdapter = new OpenAIAdapter({
  openai: new OpenAI({ baseURL: provider.baseURL, apiKey: provider.key }),
  model: process.env.COPILOT_LLM_MODEL ?? provider.model,
  keepSystemRole: true,
});
const runtime = new CopilotRuntime();

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
};
