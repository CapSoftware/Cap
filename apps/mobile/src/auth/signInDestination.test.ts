import { describe, expect, it } from "vitest";
import { signInTitleForSegments } from "./signInDestination";

describe("signInTitleForSegments", () => {
	it("uses contextual auth titles for deep-linked mobile surfaces", () => {
		expect(signInTitleForSegments(["(tabs)", "upload"])).toBe(
			"Sign in to import",
		);
		expect(signInTitleForSegments(["caps", "[id]"])).toBe("Sign in to view");
		expect(signInTitleForSegments(["(tabs)"])).toBe("Sign in to Cap");
	});
});
