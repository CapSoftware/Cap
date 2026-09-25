import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/database/schema", () => ({
	folders: {},
	organizationMembers: {},
	organizations: {},
	sharedVideos: {},
	spaceMembers: {},
	spaces: {},
	spaceVideos: {},
	videos: {},
}));

import {
	pickShareDashboardDestination,
	type ShareDashboardAccess,
} from "@/lib/share-dashboard-destination";

const access = (
	overrides: Partial<ShareDashboardAccess>,
): ShareDashboardAccess => ({
	isOwner: false,
	activeOrganizationId: "org-active",
	ownerFolder: null,
	memberSpaces: [],
	memberOrganizations: [],
	...overrides,
});

describe("pickShareDashboardDestination", () => {
	it("sends the owner back to My Caps", () => {
		expect(pickShareDashboardDestination(access({ isOwner: true }))).toEqual({
			kind: "caps",
			href: "/dashboard/caps",
			label: "My Caps",
		});
	});

	it("sends the owner back to the folder the Cap lives in", () => {
		expect(
			pickShareDashboardDestination(
				access({
					isOwner: true,
					ownerFolder: { id: "folder-1", name: "Launch" },
				}),
			),
		).toEqual({
			kind: "folder",
			href: "/dashboard/folder/folder-1",
			label: "Launch",
		});
	});

	it("ignores spaces for the owner", () => {
		expect(
			pickShareDashboardDestination(
				access({
					isOwner: true,
					memberSpaces: [
						{ id: "space-1", name: "Design", organizationId: "org-active" },
					],
				}),
			)?.kind,
		).toBe("caps");
	});

	it("sends a space member to the space the Cap was shared into", () => {
		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-1", name: "Design", organizationId: "org-active" },
					],
				}),
			),
		).toEqual({
			kind: "space",
			href: "/dashboard/spaces/space-1",
			label: "Design",
		});
	});

	it("sends an organization member to the organization's shared view", () => {
		expect(
			pickShareDashboardDestination(
				access({
					memberOrganizations: [{ id: "org-active", name: "Acme" }],
				}),
			),
		).toEqual({
			kind: "organization",
			href: "/dashboard/spaces/org-active",
			label: "Acme",
		});
	});

	it("prefers destinations in the viewer's active organization", () => {
		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-other", name: "Other", organizationId: "org-other" },
						{ id: "space-active", name: "Mine", organizationId: "org-active" },
					],
				}),
			)?.href,
		).toBe("/dashboard/spaces/space-active");

		expect(
			pickShareDashboardDestination(
				access({
					memberSpaces: [
						{ id: "space-other", name: "Other", organizationId: "org-other" },
					],
					memberOrganizations: [{ id: "org-active", name: "Acme" }],
				}),
			)?.href,
		).toBe("/dashboard/spaces/org-active");
	});

	it("offers nothing to a signed-in viewer the Cap was never shared with", () => {
		expect(pickShareDashboardDestination(access({}))).toBeNull();
	});
});
