import { describe, expect, it } from "vitest";

import { OrganizationHexColor, OrganizationLogoUpdate } from "./desktop";

describe("desktop API contract schemas", () => {
	it("accepts valid org brand hex colors", () => {
		expect(OrganizationHexColor.parse("#A1b2C3")).toBe("#A1b2C3");
	});

	it("rejects invalid org brand hex colors", () => {
		expect(() => OrganizationHexColor.parse("#GGGGGG")).toThrow();
		expect(() => OrganizationHexColor.parse("123456")).toThrow();
	});

	it("validates logo update variants", () => {
		expect(OrganizationLogoUpdate.parse({ action: "keep" }).action).toBe("keep");
		expect(() =>
			OrganizationLogoUpdate.parse({
				action: "upload",
				contentType: "image/png",
				data: "",
			}),
		).toThrow();
	});
});
