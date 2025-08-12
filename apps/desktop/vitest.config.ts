import { join } from "node:path";
import { defineConfig } from "vitest/config";

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
