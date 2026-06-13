import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("storybook Vite config", () => {
	it("loads Solid and Cap UI plugins", () => {
		const plugins = config.plugins ?? [];

		expect(
			plugins.some(
				(plugin) => !Array.isArray(plugin) && plugin?.name === "solid",
			),
		).toBe(true);
		expect(
			plugins.some(
				(plugin) =>
					Array.isArray(plugin) &&
					plugin.some((entry) => entry?.name === "unplugin-icons"),
			),
		).toBe(true);
	});
});
