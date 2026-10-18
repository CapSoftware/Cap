import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		setupFiles: ["./__tests__/setup.ts"],
	},
});
