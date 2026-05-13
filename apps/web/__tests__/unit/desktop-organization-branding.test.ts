import { OrganizationBrandingPatchBody } from "@cap/web-api-contract";
import { describe, expect, it } from "vitest";
import {
	canEditOrganizationBranding,
	type DesktopOrganizationRow,
	decodeOrganizationLogoUpdate,
	filterAccessibleOrganizationRows,
	MAX_ORGANIZATION_LOGO_BYTES,
	mergeOrganizationBrandingMetadata,
	normalizeOrganizationBrandingPatchBody,
	OrganizationBrandingValidationError,
	organizationBrandColorsFromMetadata,
	toDesktopOrganization,
} from "@/app/api/desktop/[...route]/organization-branding";

function row(
	overrides: Partial<DesktopOrganizationRow> = {},
): DesktopOrganizationRow {
	return {
		id: "org-1",
		name: "Acme",
		ownerId: "user-1",
		tombstoneAt: null,
		iconUrl: null,
		metadata: null,
		role: null,
		...overrides,
	};
}

describe("desktop organization branding", () => {
	it("reads and normalizes brand colours from metadata", () => {
		expect(
			organizationBrandColorsFromMetadata({
				branding: {
					colors: {
						primary: "#abcdef",
						secondary: "blue",
						accent: null,
						background: "#123456",
					},
				},
			}),
		).toEqual({
			primary: "#ABCDEF",
			secondary: null,
			accent: null,
			background: "#123456",
		});
	});

	it("preserves unrelated metadata when merging brand colours", () => {
		expect(
			mergeOrganizationBrandingMetadata(
				{
					theme: "dark",
					branding: {
						shape: "rounded",
						colors: {
							primary: "#000000",
						},
					},
				},
				{
					primary: "#111111",
					secondary: null,
					accent: "#222222",
					background: null,
				},
			),
		).toEqual({
			theme: "dark",
			branding: {
				shape: "rounded",
				colors: {
					primary: "#111111",
					secondary: null,
					accent: "#222222",
					background: null,
				},
			},
		});
	});

	it("filters tombstoned and inaccessible organization rows", () => {
		const rows = [
			row({ id: "owned" }),
			row({ id: "member", ownerId: "user-2", role: "member" }),
			row({ id: "owner-member", ownerId: "user-2", role: "owner" }),
			row({ id: "tombstone", tombstoneAt: new Date() }),
			row({ id: "stranger", ownerId: "user-2" }),
		];

		expect(
			filterAccessibleOrganizationRows(rows, "user-1").map((r) => r.id),
		).toEqual(["owned", "member", "owner-member"]);
	});

	it("derives owner role and edit access from ownership", () => {
		expect(
			toDesktopOrganization(
				row({
					metadata: {
						branding: {
							colors: {
								primary: "#4785ff",
							},
						},
					},
				}),
				"user-1",
				"https://example.com/logo.png",
			),
		).toEqual({
			id: "org-1",
			name: "Acme",
			ownerId: "user-1",
			role: "owner",
			canEditBrand: true,
			iconUrl: "https://example.com/logo.png",
			brandColors: {
				primary: "#4785FF",
				secondary: null,
				accent: null,
				background: null,
			},
		});
	});

	it("rejects non-owner and tombstoned branding edits", () => {
		expect(
			canEditOrganizationBranding(
				row({ ownerId: "user-2", role: "member" }),
				"user-1",
			),
		).toBe(false);
		expect(
			canEditOrganizationBranding(row({ tombstoneAt: new Date() }), "user-1"),
		).toBe(false);
		expect(
			canEditOrganizationBranding(
				row({ ownerId: "user-2", role: "owner" }),
				"user-1",
			),
		).toBe(true);
	});

	it("validates and normalizes branding patch payloads", () => {
		expect(
			OrganizationBrandingPatchBody.safeParse({
				brandColors: {
					primary: "#12345G",
					secondary: null,
					accent: null,
					background: null,
				},
			}).success,
		).toBe(false);

		expect(
			normalizeOrganizationBrandingPatchBody({
				brandColors: {
					primary: "#abcdef",
					secondary: null,
					accent: "#123456",
					background: null,
				},
			}),
		).toEqual({
			brandColors: {
				primary: "#ABCDEF",
				secondary: null,
				accent: "#123456",
				background: null,
			},
			logo: { action: "keep" },
		});
	});

	it("validates logo uploads", () => {
		const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
			"base64",
		);

		expect(
			decodeOrganizationLogoUpdate({
				action: "upload",
				contentType: "image/png",
				data,
			}),
		).toMatchObject({
			action: "upload",
			contentType: "image/png",
			fileName: "logo.png",
		});

		expect(() =>
			decodeOrganizationLogoUpdate({
				action: "upload",
				contentType: "image/png",
				data: "not-base64!",
			}),
		).toThrow(OrganizationBrandingValidationError);

		expect(() =>
			decodeOrganizationLogoUpdate({
				action: "upload",
				contentType: "image/jpeg",
				data,
			}),
		).toThrow(OrganizationBrandingValidationError);

		expect(() =>
			decodeOrganizationLogoUpdate({
				action: "upload",
				contentType: "image/png",
				data: Buffer.alloc(MAX_ORGANIZATION_LOGO_BYTES + 1).toString("base64"),
			}),
		).toThrow(OrganizationBrandingValidationError);
	});
});
