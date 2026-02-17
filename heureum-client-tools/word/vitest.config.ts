import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist", "assets/**"],
    testTimeout: 30000,
  },
});
