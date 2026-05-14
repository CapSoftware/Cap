import { describe, expect, it } from "vitest";
import {
	contract,
	DesktopOrganization,
	licenseContract,
	Notification,
	OrganizationBrandingPatchBody,
	orgCustomDomainContract,
} from "./index";

describe("desktop contract schemas", () => {
	it("parses organization branding payloads with uploaded logos", () => {
		const parsed = OrganizationBrandingPatchBody.parse({
			brandColors: {
				primary: "#111111",
				secondary: null,
				accent: "#BADA55",
				background: "#ffffff",
			},
			logo: {
				action: "upload",
				contentType: "image/png",
				data: "base64-logo",
			},
		});

		expect(parsed.logo?.action).toBe("upload");
		expect(
			OrganizationBrandingPatchBody.safeParse({
				brandColors: {
					primary: "111111",
					secondary: null,
					accent: null,
					background: null,
				},
			}).success,
		).toBe(false);
	});

	it("validates desktop organizations with nullable brand fields", () => {
		expect(
			DesktopOrganization.parse({
				id: "org_123",
				name: "Cap Team",
				ownerId: "user_123",
				role: "owner",
				canEditBrand: true,
				iconUrl: null,
				brandColors: {
					primary: null,
					secondary: "#123ABC",
					accent: null,
					background: "#000000",
				},
			}),
		).toMatchObject({ role: "owner", canEditBrand: true });
	});
});

describe("notification contract schema", () => {
	it("coerces notification timestamps and rejects unknown notification types", () => {
		const parsed = Notification.parse({
			id: "notification_123",
			readAt: null,
			createdAt: "2026-05-14T20:00:00.000Z",
			type: "comment",
			videoId: "video_123",
			author: { id: "user_123", name: "Ada", avatar: null },
			comment: { id: "comment_123", content: "Looks good" },
		});

		expect(parsed.createdAt).toBeInstanceOf(Date);
		expect(Notification.safeParse({ ...parsed, type: "mention" }).success).toBe(
			false,
		);
	});
});

describe("route contracts", () => {
	it("keeps core video and notification routes stable", () => {
		expect(contract.video.getTranscribeStatus).toMatchObject({
			method: "GET",
			path: "/video/transcribe/status",
		});
		expect(contract.video.delete).toMatchObject({
			method: "DELETE",
			path: "/video/delete",
		});
		expect(contract.notifications.get).toMatchObject({
			method: "GET",
			path: "/notifications",
		});
	});

	it("keeps commercial license and custom domain routes stable", () => {
		expect(licenseContract.activateCommercialLicense).toMatchObject({
			method: "POST",
			path: "/commercial/activate",
		});
		expect(
			licenseContract.createCommercialCheckoutUrl.body.safeParse({
				type: "monthly",
			}).success,
		).toBe(false);
		expect(orgCustomDomainContract.getOrgCustomDomain).toMatchObject({
			method: "GET",
			path: "/org-custom-domain",
		});
	});
});
