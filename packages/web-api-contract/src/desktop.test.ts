import { describe, expect, it } from "vitest";
import {
	OrganizationBrandingPatchBody,
	OrganizationHexColor,
	OrganizationLogoUpdate,
} from "./desktop";

describe("desktop contract schemas", () => {
	it("accepts valid organization brand colors and rejects malformed hex", () => {
		expect(OrganizationHexColor.safeParse("#ABC123").success).toBe(true);
		expect(OrganizationHexColor.safeParse("ABC123").success).toBe(false);
		expect(OrganizationHexColor.safeParse("#12345").success).toBe(false);
	});

	it("validates logo upload payloads", () => {
		expect(
			OrganizationLogoUpdate.safeParse({
				action: "upload",
				contentType: "image/png",
				data: "base64-data",
			}).success,
		).toBe(true);
		expect(
			OrganizationLogoUpdate.safeParse({
				action: "upload",
				contentType: "image/svg+xml",
				data: "base64-data",
			}).success,
		).toBe(false);
	});

	it("parses a full branding patch body", () => {
		const result = OrganizationBrandingPatchBody.parse({
			brandColors: {
				primary: "#000000",
				secondary: null,
				accent: "#ffffff",
				background: null,
			},
			logo: { action: "keep" },
		});

		expect(result.logo).toEqual({ action: "keep" });
	});
});
