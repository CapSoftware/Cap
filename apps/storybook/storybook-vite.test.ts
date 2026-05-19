import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("storybook Vite config", () => {
	it("loads Solid and Cap UI plugins", () => {
		expect(Array.isArray(config.plugins)).toBe(true);
		expect(config.plugins).toHaveLength(2);
	});
});
