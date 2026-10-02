import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		includeSource: ["src/**/*.{js,ts,jsx,tsx}"],
		server: {
			deps: {
				inline: [
					/@solid-primitives\/(deep|event-listener|history|utils)/,
					/solid-js\/store/,
				],
			},
		},
	},
	resolve: {
		alias: {
			"~": join(process.cwd(), "src"),
		},
	},
});
