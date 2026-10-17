import { join } from "node:path";
import { configDefaults, defineWorkspace } from "vitest/config";

export default defineWorkspace([
	{
		extends: "./vitest.config.ts",
		test: {
			name: "unit",
			exclude: [...configDefaults.exclude, "**/*.solid.test.ts"],
		},
	},
	{
		resolve: {
			conditions: ["browser", "development"],
			alias: {
				"~": join(process.cwd(), "src"),
			},
		},
		test: {
			name: "solid",
			include: ["src/**/*.solid.test.ts"],
			environment: "jsdom",
			server: {
				deps: {
					inline: [/solid-js/, /@solid-primitives/],
				},
			},
		},
	},
]);
