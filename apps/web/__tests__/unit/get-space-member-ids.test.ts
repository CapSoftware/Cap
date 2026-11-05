import { Space } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSpaceMemberIds } from "@/app/(org)/dashboard/spaces/[spaceId]/actions";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	currentUser: vi.fn(),
	organizationRole: "member" as string | null,
	spaceRole: "admin" as string | null,
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.currentUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const spaceId = Space.SpaceId.make("space-1");
const memberships = [
	{ spaceId: "space-1", userId: "creator" },
	{ spaceId: "space-1", userId: "member" },
	{ spaceId: "space-2", userId: "different-member" },
];

beforeEach(() => {
	mocks.currentUser.mockResolvedValue({ id: "manager" });
	mocks.organizationRole = "member";
	mocks.spaceRole = "admin";
	mocks.query
		.mockReset()
		.mockImplementation((sql: string, params: unknown[]) => {
			if (sql.includes("from `spaces`")) {
				return {
					rows: params.includes(spaceId)
						? [
								[
									spaceId,
									"org-1",
									"creator",
									"owner",
									mocks.organizationRole,
									mocks.spaceRole,
								],
							]
						: [],
				};
			}
			return {
				rows: memberships
					.filter((membership) => params.includes(membership.spaceId))
					.map((membership) => [membership.userId]),
			};
		});
});

describe("loading space membership for editing", () => {
	it("loads only the target space's member ids for its admin", async () => {
		await expect(getSpaceMemberIds(spaceId)).resolves.toEqual([
			"creator",
			"member",
		]);
	});

	it("allows an organization admin without space membership", async () => {
		mocks.organizationRole = "admin";
		mocks.spaceRole = null;
		await expect(getSpaceMemberIds(spaceId)).resolves.toEqual([
			"creator",
			"member",
		]);
	});

	it("rejects unauthenticated callers before querying membership", async () => {
		mocks.currentUser.mockResolvedValue(null);
		await expect(getSpaceMemberIds(spaceId)).rejects.toThrow("Unauthorized");
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it.each([
		{ organizationRole: "member", spaceRole: "member" },
		{ organizationRole: null, spaceRole: "admin" },
	])("rejects callers without management access: %j", async (roles) => {
		Object.assign(mocks, roles);
		await expect(getSpaceMemberIds(spaceId)).rejects.toThrow();
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("rejects a missing space before querying membership", async () => {
		await expect(
			getSpaceMemberIds(Space.SpaceId.make("missing-space")),
		).rejects.toThrow("Space not found");
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("propagates a failed lookup instead of returning an empty member list", async () => {
		const authorize = mocks.query.getMockImplementation();
		if (!authorize) throw new Error("Missing query implementation");
		mocks.query.mockImplementationOnce(authorize).mockImplementationOnce(() => {
			throw new Error("Database unavailable");
		});
		await expect(getSpaceMemberIds(spaceId)).rejects.toMatchObject({
			cause: { message: "Database unavailable" },
		});
	});
});
