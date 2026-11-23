import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createTools, type ToolConfig } from "./tools.ts";
import { unsafeGateHook } from "./replay.ts";
import {
  configure,
  createRegistry,
  defineExtension,
  section,
  type HarnessOptions,
} from "@earendil-works/pi-durable";

const models = createModels();
models.setProvider(openaiProvider());

/** Application-owned, platform-independent agent composition. */
export function createAgentHarnessOptions(
  config: ToolConfig = { searchBackend: "corpus" },
): HarnessOptions {
  const tools = createTools(config);
  const agentExtension = defineExtension({
    name: "research-agent",
    tools: tools.all,
    hooks: [unsafeGateHook],
    sections: [
      section(
        "preamble",
        () =>
          "You are a research agent. For a research question, call research to fan out three subagents, then synthesize their answers and cite corpus document IDs. Use search directly for a quick lookup. charge_credits buys premium corpus access with fake credits; charge only when the user asks for premium depth. User messages may begin with a display name in brackets; treat it as speaker attribution.",
        { tag: false },
      ),
      section(
        "clock",
        // Minute precision: finer values would append a system-prompt delta on every request.
        () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`,
        { tag: false },
      ),
    ],
  });
  const registry = createRegistry();
  registry.install(agentExtension);
  const defaultAgent = {
    model: { provider: "openai", modelId: "gpt-6-luna" },
    thinkingLevel: "off" as const,
    tools: tools.all,
  };

  return {
    models,
    registry,
    settings: { extensions: [agentExtension] },
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, defaultAgent)
        : undefined,
  };
}
