import { userIsPro } from "@cap/utils";
import { Organisation } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	requireManager: vi.fn(),
	selectResults: [] as Record<string, unknown>[][],
	user: {
		thirdPartyStripeSubscriptionId: "sub_owner" as string | null,
		activeOrganizationId: "org",
		defaultOrgId: "org" as string | null,
	},
}));

const lockRows = vi.fn();
const selectWhere = vi.fn<(condition: SQL) => void>();

type SelectQuery = Promise<unknown[]> & {
	from(): SelectQuery;
	innerJoin(): SelectQuery;
	leftJoin(): SelectQuery;
	orderBy(): SelectQuery;
	where(condition: SQL): SelectQuery;
	limit(): SelectQuery;
	for(mode: string): SelectQuery;
};

function selectQuery(fields?: Record<string, unknown>) {
	const rows = mocks.selectResults.shift() ?? [];
	const query: SelectQuery = Object.assign(
		Promise.resolve(
			fields
				? rows.map((row) =>
						Object.fromEntries(
							Object.keys(fields).map((key) => [key, row[key]]),
						),
					)
				: rows,
		),
		{
			from: () => query,
			innerJoin: () => query,
			leftJoin: () => query,
			orderBy: () => query,
			where: (condition: SQL) => {
				selectWhere(condition);
				return query;
			},
			limit: () => query,
			for: (mode: string) => {
				lockRows(mode);
				return query;
			},
		},
	);
	return query;
}

const updateSet = vi.fn((value: Partial<typeof mocks.user>) => {
	Object.assign(mocks.user, value);
	return { where: async () => [{ affectedRows: 1 }] };
});

const database = {
	select: vi.fn(selectQuery),
	delete: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })),
	update: vi.fn(() => ({ set: updateSet })),
	transaction: vi.fn(async (fn: (tx: typeof database) => Promise<unknown>) =>
		fn(database),
	),
};

vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: mocks.requireManager,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function removeSeat(
	remainingSeats: { stripeSubscriptionId: string | null }[],
) {
	mocks.selectResults = [
		[
			{
				id: "member",
				userId: "teammate",
				role: "member",
				email: "t@example.com",
				hasProSeat: true,
				activeOrganizationId: "org",
				defaultOrgId: "org",
			},
		],
		[{ id: "teammate" }],
		remainingSeats,
		[],
		[{ id: "personal" }],
	];
	const { removeOrganizationMember } = await import(
		"@/actions/organization/remove-member"
	);
	await removeOrganizationMember(
		"member",
		Organisation.OrganisationId.make("org"),
	);
}

describe("removeOrganizationMember", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.user.thirdPartyStripeSubscriptionId = "sub_owner";
		mocks.user.activeOrganizationId = "org";
		mocks.user.defaultOrgId = "org";
		mocks.selectResults = [];
		mocks.getCurrentUser.mockResolvedValue({ id: "owner" });
		mocks.requireManager.mockResolvedValue({ ownerId: "owner", role: "owner" });
	});

	it("revokes Pro access when the removed seat was the user's last seat", async () => {
		await removeSeat([]);

		expect(lockRows).toHaveBeenCalledWith("update");
		expect(mocks.user.activeOrganizationId).toBe("personal");
		expect(mocks.user.defaultOrgId).toBe("personal");
		expect(userIsPro({ stripeSubscriptionStatus: null, ...mocks.user })).toBe(
			false,
		);
	});

	it("keeps Pro access through another organization's seat", async () => {
		await removeSeat([{ stripeSubscriptionId: "sub_other" }]);

		expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_other");
		expect(userIsPro({ stripeSubscriptionStatus: null, ...mocks.user })).toBe(
			true,
		);
	});

	it("keeps Pro access when another seat is sponsored by a manager", async () => {
		await removeSeat([{ stripeSubscriptionId: null }]);

		expect(userIsPro({ stripeSubscriptionStatus: null, ...mocks.user })).toBe(
			true,
		);
	});

	it("prefers a remaining seat the organization owner pays for", async () => {
		await removeSeat([
			{ stripeSubscriptionId: null },
			{ stripeSubscriptionId: "sub_other" },
		]);

		expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_other");
	});
});

describe("removed member organization references", () => {
	beforeEach(() => {
		mocks.getCurrentUser.mockResolvedValue({ id: "owner" });
		mocks.requireManager.mockResolvedValue({ ownerId: "owner", role: "owner" });
	});

	it.each([
		["both references", "org", "org", "other", "other"],
		["only the active organization", "org", "preferred", "other", "preferred"],
		["only the default organization", "active", "org", "active", "other"],
		["neither reference", "active", "preferred", "active", "preferred"],
	])(
		"repairs %s without switching an unrelated organization",
		async (
			_,
			activeOrganizationId,
			defaultOrgId,
			expectedActive,
			expectedDefault,
		) => {
			Object.assign(mocks.user, { activeOrganizationId, defaultOrgId });
			mocks.selectResults = [
				[
					{
						id: "member",
						userId: "teammate",
						role: "member",
						email: "t@example.com",
						hasProSeat: false,
						activeOrganizationId,
						defaultOrgId,
					},
				],
				[],
				[{ id: "other" }],
			];
			const { removeOrganizationMember } = await import(
				"@/actions/organization/remove-member"
			);

			await removeOrganizationMember(
				"member",
				Organisation.OrganisationId.make("org"),
			);

			expect(mocks.user.activeOrganizationId).toBe(expectedActive);
			expect(mocks.user.defaultOrgId).toBe(expectedDefault);
			if (activeOrganizationId !== "org" && defaultOrgId !== "org") {
				expect(database.update).not.toHaveBeenCalled();
			} else {
				const condition = selectWhere.mock.calls.at(-1)?.[0];
				expect(condition).toBeDefined();
				if (!condition) throw new Error("Missing fallback query");
				const query = new MySqlDialect().sqlToQuery(condition);
				expect(query.params).toEqual(["org", "teammate", "teammate"]);
				expect(query.sql).toBe(
					"(`organizations`.`id` <> ? and `organizations`.`tombstoneAt` is null and (`organizations`.`ownerId` = ? or `organization_members`.`userId` = ?))",
				);
			}
		},
	);

	it("clears references when no organization remains", async () => {
		Object.assign(mocks.user, {
			activeOrganizationId: "org",
			defaultOrgId: "org",
		});
		mocks.selectResults = [
			[
				{
					id: "member",
					userId: "teammate",
					role: "member",
					email: "t@example.com",
					hasProSeat: false,
					activeOrganizationId: "org",
					defaultOrgId: "org",
				},
			],
			[],
			[],
		];
		const { removeOrganizationMember } = await import(
			"@/actions/organization/remove-member"
		);

		await removeOrganizationMember(
			"member",
			Organisation.OrganisationId.make("org"),
		);

		expect(mocks.user.activeOrganizationId).toBe("");
		expect(mocks.user.defaultOrgId).toBeNull();
	});

	it.each([
		["missing", []],
		["owner", [{ id: "member", userId: "owner", role: "owner" }]],
	])("does not update references for a %s target", async (_, rows) => {
		mocks.selectResults = [rows];
		const { removeOrganizationMember } = await import(
			"@/actions/organization/remove-member"
		);

		await expect(
			removeOrganizationMember(
				"member",
				Organisation.OrganisationId.make("org"),
			),
		).rejects.toThrow();

		expect(database.update).not.toHaveBeenCalled();
		expect(database.delete).not.toHaveBeenCalled();
	});
});
