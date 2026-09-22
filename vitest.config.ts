import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests never touch the network: fixtures and golden vectors are checked in.
  },
});
