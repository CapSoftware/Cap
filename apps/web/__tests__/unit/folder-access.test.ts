import { Organisation, Space, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	organizationAccess: vi.fn(),
	spaceAccess: vi.fn(),
}));

vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.spaceAccess,
}));

import { canViewFolder } from "@/actions/folders/folder-access";

const userId = User.UserId.make("user-1");
const otherUserId = User.UserId.make("user-2");
const organizationId = Organisation.OrganisationId.make("org-1");
const spaceId = Space.SpaceId.make("space-1");

describe("canViewFolder", () => {
	beforeEach(() => {
		mocks.organizationAccess.mockReset();
		mocks.spaceAccess.mockReset();
	});

	it("limits personal folders to their creator", async () => {
		const folder = { organizationId, spaceId: null, createdById: userId };

		await expect(canViewFolder(userId, folder)).resolves.toBe(true);
		await expect(canViewFolder(otherUserId, folder)).resolves.toBe(false);
		expect(mocks.organizationAccess).not.toHaveBeenCalled();
		expect(mocks.spaceAccess).not.toHaveBeenCalled();
	});

	it("allows organization members into organization folders", async () => {
		const folder = {
			organizationId,
			spaceId: organizationId,
			createdById: otherUserId,
		};

		mocks.organizationAccess.mockResolvedValueOnce({ role: "member" });
		await expect(canViewFolder(userId, folder)).resolves.toBe(true);

		mocks.organizationAccess.mockResolvedValueOnce(null);
		await expect(canViewFolder(userId, folder)).resolves.toBe(false);
		expect(mocks.organizationAccess).toHaveBeenCalledWith(
			userId,
			organizationId,
		);
		expect(mocks.spaceAccess).not.toHaveBeenCalled();
	});

	it("requires a space role or organization admin for space folders", async () => {
		const folder = { organizationId, spaceId, createdById: otherUserId };

		mocks.spaceAccess.mockResolvedValueOnce({
			organizationId,
			organizationRole: null,
			spaceRole: "member",
		});
		await expect(canViewFolder(userId, folder)).resolves.toBe(true);

		mocks.spaceAccess.mockResolvedValueOnce({
			organizationId,
			organizationRole: "admin",
			spaceRole: null,
		});
		await expect(canViewFolder(userId, folder)).resolves.toBe(true);

		mocks.spaceAccess.mockResolvedValueOnce({
			organizationId,
			organizationRole: null,
			spaceRole: null,
		});
		await expect(canViewFolder(userId, folder)).resolves.toBe(false);

		mocks.spaceAccess.mockResolvedValueOnce(null);
		await expect(canViewFolder(userId, folder)).resolves.toBe(false);
	});

	it("rejects an organization member who is not in the space", async () => {
		mocks.spaceAccess.mockResolvedValueOnce({
			organizationId,
			organizationRole: "member",
			spaceRole: null,
		});

		await expect(
			canViewFolder(userId, {
				organizationId,
				spaceId,
				createdById: otherUserId,
			}),
		).resolves.toBe(false);
	});

	it("rejects space folders whose space belongs to another organization", async () => {
		mocks.spaceAccess.mockResolvedValueOnce({
			organizationId: Organisation.OrganisationId.make("org-2"),
			organizationRole: "owner",
			spaceRole: "admin",
		});

		await expect(
			canViewFolder(userId, {
				organizationId,
				spaceId,
				createdById: otherUserId,
			}),
		).resolves.toBe(false);
	});
});
