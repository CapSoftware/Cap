import { Space } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	access: vi.fn(),
	select: vi.fn(),
	rows: [] as Array<{ userId: string }>,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (...args: unknown[]) => {
			mocks.select(...args);
			return { from: () => ({ where: async () => mocks.rows }) };
		},
	}),
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/actions/organization/space-authorization", () => ({
	getSpaceAccess: mocks.access,
}));

import { getSpaceMemberIds } from "@/actions/organization/get-space-member-ids";

const spaceId = Space.SpaceId.make("space-1");

describe("getSpaceMemberIds", () => {
	beforeEach(() => {
		mocks.user.mockReset();
		mocks.access.mockReset();
		mocks.select.mockReset();
		mocks.rows = [{ userId: "user-1" }, { userId: "user-2" }];
	});

	it("returns the space's members to someone who can manage it", async () => {
		mocks.user.mockResolvedValue({ id: "user-1" });
		mocks.access.mockResolvedValue({ canManage: true });

		await expect(getSpaceMemberIds(spaceId)).resolves.toEqual([
			"user-1",
			"user-2",
		]);
		expect(mocks.access).toHaveBeenCalledWith("user-1", spaceId);
	});

	it("returns nothing to a member who cannot manage the space", async () => {
		mocks.user.mockResolvedValue({ id: "user-3" });
		mocks.access.mockResolvedValue({ canManage: false });

		await expect(getSpaceMemberIds(spaceId)).resolves.toBeNull();
		expect(mocks.select).not.toHaveBeenCalled();
	});

	it("returns nothing without access or a signed-in user", async () => {
		mocks.user.mockResolvedValue({ id: "user-4" });
		mocks.access.mockResolvedValue(null);
		await expect(getSpaceMemberIds(spaceId)).resolves.toBeNull();

		mocks.user.mockResolvedValue(null);
		await expect(getSpaceMemberIds(spaceId)).resolves.toBeNull();
		expect(mocks.select).not.toHaveBeenCalled();
	});
});
