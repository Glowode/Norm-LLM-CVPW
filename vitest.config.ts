// Vitest configuration for the framework repo.
// Projects scaffolded by `cvpw new` get their own config from templates/project.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "reference/**", "examples/**/node_modules/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    reporters: ["default"],
  },
});
