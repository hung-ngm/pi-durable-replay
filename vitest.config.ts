import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workerd cannot read Vitest 5's host-filesystem module cache.
  test: {
    fsModuleCache: false,
    // Vendored coding-agent skills (.agents/skills, symlinked from .claude/skills) ship
    // their own test files for other runners; they are not this project's tests.
    exclude: ["**/node_modules/**", "**/dist/**", ".agents/**", ".claude/**"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { OPENAI_API_KEY: "test-openai-key" } },
    }),
  ],
});
