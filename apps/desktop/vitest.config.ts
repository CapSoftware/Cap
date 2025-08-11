import { defineConfig } from "vitest/config";
import { join } from "node:path";

export default defineConfig({
  test: {
    includeSource: ["src/**/*.{js,ts,jsx,tsx}"],
  },
  resolve: {
    alias: {
      "~": join(process.cwd(), "src"),
    },
  },
});
