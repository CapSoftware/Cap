import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("../../apps/web", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
