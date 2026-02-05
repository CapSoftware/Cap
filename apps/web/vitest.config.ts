import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		jsx: "automatic",
	},
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
		globals: true,
		setupFiles: ["./__tests__/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["lib/**/*.ts", "workflows/**/*.ts", "actions/**/*.ts"],
			exclude: [
				"**/*.d.ts",
				"**/__tests__/**",
				"**/node_modules/**",
				"**/.next/**",
			],
		},
		testTimeout: 30000,
		hookTimeout: 30000,
	},
	resolve: {
		alias: {
			"@/app": join(process.cwd(), "app"),
			"@/components": join(process.cwd(), "components"),
			"@/pages": join(process.cwd(), "components/pages"),
			"@/utils": join(process.cwd(), "utils"),
			"@/lib": join(process.cwd(), "lib"),
			"@/actions": join(process.cwd(), "actions"),
			"@/data": join(process.cwd(), "data"),
			"@/services": join(process.cwd(), "services"),
			"@/workflows": join(process.cwd(), "workflows"),
		},
	},
});
