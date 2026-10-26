import { Organisation, Space } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSpaceVideoIds } from "@/actions/spaces/get-space-videos";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	user: vi.fn(),
	organizationAccess: vi.fn(),
	spaceAccess: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.spaceAccess,
}));

const orgId = Organisation.OrganisationId.make("org-1");
const spaceId = Space.SpaceId.make("space-1");

const spaceAccess = (
	organizationRole: "owner" | "admin" | "member" | null,
	spaceRole: "admin" | "member" | null,
) => ({
	spaceId,
	organizationId: orgId,
	organizationOwnerId: "owner",
	createdById: "creator",
	organizationRole,
	spaceRole,
	canManage: false,
});

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.user.mockResolvedValue({ id: "user-1", activeOrganizationId: orgId });
	mocks.query.mockResolvedValue({ rows: [["video-1"], ["video-2"]] });
});

describe("getSpaceVideoIds for a space", () => {
	it("lists the videos for a member of the space", async () => {
		mocks.spaceAccess.mockResolvedValue(spaceAccess("member", "member"));

		await expect(getSpaceVideoIds(spaceId)).resolves.toEqual({
			success: true,
			data: ["video-1", "video-2"],
		});
	});

	it("lists the videos for an organization admin outside the space", async () => {
		mocks.spaceAccess.mockResolvedValue(spaceAccess("admin", null));

		await expect(getSpaceVideoIds(spaceId)).resolves.toMatchObject({
			success: true,
		});
	});

	// The space page only opens a space for its members and for organization
	// admins and owners (Spaces.getSpaceOrOrg), so this action must not list
	// the videos of a space to anyone else in the organization.
	it("rejects an organization member who is not in the space", async () => {
		mocks.spaceAccess.mockResolvedValue(spaceAccess("member", null));

		await expect(getSpaceVideoIds(spaceId)).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("rejects a caller with no access to the space", async () => {
		mocks.spaceAccess.mockResolvedValue(null);

		await expect(getSpaceVideoIds(spaceId)).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.query).not.toHaveBeenCalled();
	});
});

describe("getSpaceVideoIds for the organization-wide entry", () => {
	it("lists the videos for any organization member", async () => {
		mocks.organizationAccess.mockResolvedValue({ role: "member" });

		await expect(getSpaceVideoIds(orgId)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.spaceAccess).not.toHaveBeenCalled();
	});

	it("rejects a caller outside the organization", async () => {
		mocks.organizationAccess.mockResolvedValue(null);

		await expect(getSpaceVideoIds(orgId)).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.query).not.toHaveBeenCalled();
	});
});
