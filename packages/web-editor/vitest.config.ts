import { resolve } from "node:path";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [solid({ hot: false })],
	resolve: {
		conditions: ["browser", "development"],
		alias: [
			{
				find: /^~\//,
				replacement: `${resolve(import.meta.dirname, "src/app")}/`,
			},
		],
	},
	test: {
		include: ["src/**/*.test.{ts,tsx}"],
		environment: "node",
		server: { deps: { inline: [/solid-js/, /@solid-primitives/] } },
	},
});
