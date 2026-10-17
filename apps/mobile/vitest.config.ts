import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "react",
	},
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
		dedupe: ["react", "react-test-renderer"],
	},
	test: {
		// react-test-renderer is hoisted to the workspace root, where Node would pair it with the
		// web app's React instead of the Expo-pinned React in apps/mobile/node_modules.
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: [
						"react",
						"react/jsx-runtime",
						"react/jsx-dev-runtime",
						"react-test-renderer",
					],
				},
			},
		},
	},
});
