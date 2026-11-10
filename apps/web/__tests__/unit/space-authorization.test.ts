import { Organisation, Space, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSpaceAccess,
	requireSpaceManager,
} from "@/actions/organization/space-authorization";
import { addSpaceMember } from "@/app/(org)/dashboard/spaces/[spaceId]/actions";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[],
	insert: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const query = Object.assign(Promise.resolve(mocks.rows), {
				from: () => query,
				innerJoin: () => query,
				leftJoin: () => query,
				where: () => query,
				limit: async () => mocks.rows,
			});
			return query;
		},
		insert: mocks.insert,
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "creator" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const userId = User.UserId.make("creator");
const spaceId = Space.SpaceId.make("space-1");

function spaceRow(
	overrides: {
		createdById?: string;
		ownerId?: string;
		organizationMemberRole?: string | null;
		spaceMemberRole?: string | null;
	} = {},
) {
	return {
		id: spaceId,
		organizationId: Organisation.OrganisationId.make("org-1"),
		createdById: userId,
		ownerId: User.UserId.make("owner"),
		organizationMemberRole: "member",
		spaceMemberRole: "admin",
		...overrides,
	};
}

beforeEach(() => {
	mocks.rows = [spaceRow()];
	mocks.insert.mockReturnValue({ values: async () => undefined });
});

describe("space authorization", () => {
	it("revokes a removed organization member's implicit creator access", async () => {
		mocks.rows = [
			spaceRow({ organizationMemberRole: null, spaceMemberRole: null }),
		];

		await expect(getSpaceAccess(userId, spaceId)).resolves.toBeNull();
		await expect(requireSpaceManager(userId, spaceId)).rejects.toThrow();
	});

	it("prevents a removed creator from adding space members", async () => {
		mocks.rows = [
			spaceRow({ organizationMemberRole: null, spaceMemberRole: null }),
		];

		await expect(
			addSpaceMember({
				spaceId,
				userId: User.UserId.make("owner"),
				role: "admin",
			}),
		).rejects.toThrow("Space not found");
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("does not grant access through a stale space admin membership", async () => {
		mocks.rows = [
			spaceRow({ createdById: "other", organizationMemberRole: null }),
		];

		await expect(getSpaceAccess(userId, spaceId)).resolves.toBeNull();
	});

	it.each([
		["creator", { spaceMemberRole: null }],
		["space admin", { createdById: "other", spaceMemberRole: "Admin" }],
		[
			"organization admin",
			{
				createdById: "other",
				organizationMemberRole: "admin",
				spaceMemberRole: null,
			},
		],
		[
			"organization owner without a membership row",
			{
				createdById: "other",
				ownerId: "creator",
				organizationMemberRole: null,
				spaceMemberRole: null,
			},
		],
	])("keeps management access for a current %s", async (_, overrides) => {
		mocks.rows = [spaceRow(overrides)];

		await expect(requireSpaceManager(userId, spaceId)).resolves.toMatchObject({
			canManage: true,
		});
	});

	it("keeps regular space members from managing members", async () => {
		mocks.rows = [
			spaceRow({ createdById: "other", spaceMemberRole: "member" }),
		];

		await expect(getSpaceAccess(userId, spaceId)).resolves.toMatchObject({
			organizationRole: "member",
			spaceRole: "member",
			canManage: false,
		});
		await expect(requireSpaceManager(userId, spaceId)).rejects.toThrow(
			"Only space admins, organization admins, and owners can manage this space",
		);
	});
});
