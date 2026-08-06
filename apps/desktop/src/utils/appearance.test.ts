import { describe, expect, it } from "vitest";
import { appearanceIsDark } from "./appearance";

describe("appearanceIsDark", () => {
	it("honors explicit dark appearance", () => {
		expect(appearanceIsDark("dark", false)).toBe(true);
	});

	it("honors explicit light appearance", () => {
		expect(appearanceIsDark("light", true)).toBe(false);
	});

	it.each([null, undefined, "system"] as const)(
		"uses the system preference for %s appearance",
		(appearance) => {
			expect(appearanceIsDark(appearance, true)).toBe(true);
			expect(appearanceIsDark(appearance, false)).toBe(false);
		},
	);
});
