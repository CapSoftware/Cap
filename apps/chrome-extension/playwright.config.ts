import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	expect: {
		timeout: 15_000,
	},
	reporter: [["list"]],
});
