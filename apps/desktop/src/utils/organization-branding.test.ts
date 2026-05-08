import { describe, expect, it } from "vitest";
import {
	type DesktopOrganization,
	getOrganizationBrandColorSwatches,
	getSelectedOrganizationId,
	hasAvailableOrganizationCache,
	normalizeDesktopOrganization,
} from "./organization-branding";

const organizations: DesktopOrganization[] = [
	{
		id: "org-1",
		name: "Acme",
		ownerId: "user-1",
		role: "owner",
		canEditBrand: true,
		iconUrl: null,
		brandColors: {
			primary: "#4785FF",
			secondary: null,
			accent: null,
			background: null,
		},
	},
	{
		id: "org-2",
		name: "Beta",
		ownerId: "user-2",
		role: "member",
		canEditBrand: false,
		iconUrl: "https://example.com/beta.png",
		brandColors: {
			primary: null,
			secondary: "#FFFFFF",
			accent: "#FF4766",
			background: "#000000",
		},
	},
];

describe("desktop organization branding", () => {
	it("normalizes cached organization colours", () => {
		expect(
			normalizeDesktopOrganization({
				id: "org-1",
				name: "Acme",
				ownerId: "user-1",
				role: "owner",
				canEditBrand: true,
				iconUrl: null,
				brandColors: {
					primary: "#abcdef",
					secondary: null,
					accent: "#123456",
					background: null,
				},
			}),
		).toEqual({
			id: "org-1",
			name: "Acme",
			ownerId: "user-1",
			role: "owner",
			canEditBrand: true,
			iconUrl: null,
			brandColors: {
				primary: "#ABCDEF",
				secondary: null,
				accent: "#123456",
				background: null,
			},
		});
	});

	it("normalizes older cached organization records", () => {
		expect(
			normalizeDesktopOrganization({
				id: "org-1",
				name: "Acme",
				ownerId: "user-1",
			}),
		).toEqual({
			id: "org-1",
			name: "Acme",
			ownerId: "user-1",
			role: "member",
			canEditBrand: false,
			iconUrl: null,
			brandColors: {
				primary: null,
				secondary: null,
				accent: null,
				background: null,
			},
		});
	});

	it("falls back to the first organization when the stored id is missing", () => {
		expect(getSelectedOrganizationId(organizations, "org-2")).toBe("org-2");
		expect(getSelectedOrganizationId(organizations, "missing")).toBe("org-1");
		expect(getSelectedOrganizationId(organizations, null)).toBe("org-1");
		expect(getSelectedOrganizationId([], null)).toBeNull();
	});

	it("preserves the stored organization while organizations are unavailable", () => {
		expect(getSelectedOrganizationId([], "org-2")).toBe("org-2");
	});

	it("returns available organization brand colour swatches", () => {
		expect(getOrganizationBrandColorSwatches(organizations[1])).toEqual([
			{ key: "secondary", label: "Secondary", color: "#FFFFFF" },
			{ key: "accent", label: "Accent", color: "#FF4766" },
			{ key: "background", label: "Background", color: "#000000" },
		]);
		expect(getOrganizationBrandColorSwatches(null)).toEqual([]);
	});

	it("trusts a complete persisted organization cache", () => {
		const now = 1_700_000_000_000;
		const freshUpdatedAt = Math.floor(now / 1000) - 60;
		const staleUpdatedAt = Math.floor(now / 1000) - 3 * 60 * 60;

		expect(
			hasAvailableOrganizationCache(
				{
					secret: { token: "token", expires: freshUpdatedAt + 3600 },
					user_id: "user-1",
					organizations,
					organizations_updated_at: freshUpdatedAt,
				},
				now,
			),
		).toBe(true);

		expect(
			hasAvailableOrganizationCache(
				{
					secret: { token: "token", expires: staleUpdatedAt + 3600 },
					user_id: "user-1",
					organizations,
					organizations_updated_at: staleUpdatedAt,
				},
				now,
			),
		).toBe(false);
	});
});
