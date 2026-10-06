import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		jsx: "automatic",
	},
	test: {
		// Hoisted UI peers must use web React; CommonJS UI imports still need require in Node-based jsdom tests.
		server: {
			deps: {
				inline: [
					"framer-motion",
					"motion",
					"media-chrome",
					/[/\\]node_modules[/\\]@radix-ui[/\\]/,
					"@tanstack/react-query",
					"@floating-ui/react-dom",
				],
			},
		},
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ["next/link", "next/image", "react-remove-scroll"],
				},
				web: {
					enabled: true,
					include: ["next/link", "next/image", "react-remove-scroll"],
					esbuildOptions: {
						banner: {
							js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
						},
					},
				},
			},
		},
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
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
		dedupe: ["react", "react-dom"],
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
			hooks: join(process.cwd(), "hooks"),
		},
	},
});
