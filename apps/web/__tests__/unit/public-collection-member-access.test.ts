import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicCollectionPageData } from "@/lib/public-collections";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	passwords: vi.fn(),
	results: [] as unknown[][],
	conditions: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/password-cookie", () => ({
	getVerifiedPasswordHashes: mocks.passwords,
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const result = mocks.results.shift() ?? [];
			const query = Object.assign(Promise.resolve(result), {
				from: () => query,
				innerJoin: () => query,
				leftJoin: () => query,
				where: (condition: unknown) => {
					mocks.conditions.push(condition);
					return query;
				},
				limit: () => query,
				groupBy: () => query,
				orderBy: () => query,
				offset: () => query,
			});
			return query;
		},
	}),
}));

const space = {
	id: "example-space",
	name: "Team library",
	organizationId: "example-org",
	organizationName: "Example Studio",
	organizationTombstoneAt: null,
	public: true,
	allowedEmailDomain: null,
	passwordHash: "saved-space-password",
};
const video = {
	id: "example-video",
	name: "Team update",
	createdAt: new Date("2024-01-01"),
	metadata: null,
	duration: 12,
	totalComments: 0,
	totalReactions: 0,
	ownerName: "Example Owner",
	hasPassword: true,
	hasActiveUpload: false,
};
const dialect = new MySqlDialect();
const queryAt = (index: number) =>
	dialect.sqlToQuery(mocks.conditions[index] as SQL);

describe("organization members in restricted public collections", () => {
	beforeEach(() => {
		mocks.results.length = 0;
		mocks.conditions.length = 0;
		mocks.user.mockResolvedValue({
			id: "example-member",
			email: "member@example.invalid",
		});
		mocks.passwords.mockResolvedValue([]);
	});

	it.each([
		{ passwordHash: "saved-space-password", allowedEmailDomain: null },
		{ passwordHash: null, allowedEmailDomain: "different.example.invalid" },
	])(
		"lets locked organization members bypass saved restrictions",
		async (rule) => {
			mocks.results.push(
				[],
				[{ ...space, ...rule }],
				[{ id: space.organizationId }],
				[],
				[video],
				[{ count: 1 }],
			);
			const page = await getPublicCollectionPageData(space.id, 1);
			expect(page?.access).toEqual({ state: "allowed" });
			expect(page?.videos.map((item) => item.id)).toEqual([video.id]);
			const membership = queryAt(2);
			expect(membership.sql).toContain(
				"`organizations`.`videoSharingRestrictedToOrg` = ?",
			);
			expect(membership.sql).toContain("`organizations`.`tombstoneAt` is null");
			expect(membership.params).toContain("example-member");
			for (const index of [4, 5]) {
				const selection = queryAt(index);
				expect(selection.sql).toContain("`videos`.`orgId` = ?");
				expect(selection.params).toContain(space.organizationId);
			}
		},
	);

	it("retains the password gate for outsiders and unlocked organizations", async () => {
		mocks.results.push([], [space], []);
		const page = await getPublicCollectionPageData(space.id, 1);
		expect(page?.access).toEqual({ state: "password_required" });
		expect(page?.videos).toEqual([]);
		expect(mocks.conditions).toHaveLength(3);
	});

	it("does not run member bypass queries for anonymous visitors", async () => {
		mocks.user.mockResolvedValue(null);
		mocks.results.push([], [space]);
		const page = await getPublicCollectionPageData(space.id, 1);
		expect(page?.access).toEqual({ state: "password_required" });
		expect(mocks.conditions).toHaveLength(2);
	});

	it("keeps normal collection scope after the saved password is verified", async () => {
		mocks.passwords.mockResolvedValue([space.passwordHash]);
		mocks.results.push([], [space], [], [video], [{ count: 1 }]);
		const page = await getPublicCollectionPageData(space.id, 1);
		expect(page?.access).toEqual({ state: "allowed" });
		expect(queryAt(3).params).not.toContain(space.organizationId);
	});
});
