import { userIsPro } from "@cap/utils";
import { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	requireManager: vi.fn(),
	selectResults: [] as unknown[][],
	user: { thirdPartyStripeSubscriptionId: null as string | null },
}));

const tables = vi.hoisted(() => ({
	organizationMembers: {
		id: "memberId",
		userId: "memberUserId",
		organizationId: "memberOrgId",
		hasProSeat: "hasProSeat",
	},
	organizations: { id: "orgId", ownerId: "ownerId" },
	users: {
		id: "userId",
		inviteQuota: "inviteQuota",
		stripeSubscriptionId: "subscriptionId",
		stripeSubscriptionStatus: "subscriptionStatus",
		thirdPartyStripeSubscriptionId: "thirdPartySubscriptionId",
	},
}));

const lockRows = vi.fn();
const reads: { table: unknown; joined: boolean; locked: boolean }[] = [];
const updates: { table: unknown; value: Record<string, unknown> }[] = [];

type SelectQuery = Promise<unknown[]> & {
	from(table: unknown): SelectQuery;
	innerJoin(): SelectQuery;
	where(): SelectQuery;
	limit(): SelectQuery;
	for(mode: string): SelectQuery;
};

function selectQuery() {
	const read = { table: undefined as unknown, joined: false, locked: false };
	reads.push(read);
	const query: SelectQuery = Object.assign(
		Promise.resolve(mocks.selectResults.shift() ?? []),
		{
			from: (table: unknown) => {
				read.table = table;
				return query;
			},
			innerJoin: () => {
				read.joined = true;
				return query;
			},
			where: () => query,
			limit: () => query,
			for: (mode: string) => {
				read.locked = true;
				lockRows(mode, read.table);
				return query;
			},
		},
	);
	return query;
}

const database = {
	select: vi.fn(selectQuery),
	update: vi.fn((table: unknown) => ({
		set: (value: Record<string, unknown>) => {
			updates.push({ table, value });
			if (table === tables.users && "thirdPartyStripeSubscriptionId" in value) {
				mocks.user.thirdPartyStripeSubscriptionId =
					(value.thirdPartyStripeSubscriptionId as string | null) ?? null;
			}
			return { where: async () => [{ affectedRows: 1 }] };
		},
	})),
	transaction: vi.fn(async (fn: (tx: typeof database) => Promise<unknown>) =>
		fn(database),
	),
};

vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/schema", () => tables);
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationProSeatManager: mocks.requireManager,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const organizationId = Organisation.OrganisationId.make("org");

async function toggle(enable: boolean) {
	const { toggleProSeat } = await import(
		"@/actions/organization/toggle-pro-seat"
	);
	return toggleProSeat("member", organizationId, enable);
}

async function turnSeatOff(
	remainingSeats: { stripeSubscriptionId: string | null }[],
) {
	mocks.selectResults = [
		[{ id: "member", userId: "teammate", hasProSeat: true }],
		[{ id: "teammate" }],
		remainingSeats,
	];
	await toggle(false);
}

function memberIsPro() {
	return userIsPro({ stripeSubscriptionStatus: null, ...mocks.user });
}

describe("toggleProSeat", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updates.length = 0;
		reads.length = 0;
		mocks.selectResults = [];
		mocks.user.thirdPartyStripeSubscriptionId = "sub_this_org";
		mocks.getCurrentUser.mockResolvedValue({ id: "owner" });
		mocks.requireManager.mockResolvedValue({ ownerId: "owner", role: "owner" });
	});

	describe("turning a seat off", () => {
		it("clears Pro when the user has no other seat", async () => {
			await turnSeatOff([]);

			expect(updates[0]).toEqual({
				table: tables.organizationMembers,
				value: { hasProSeat: false },
			});
			expect(mocks.user.thirdPartyStripeSubscriptionId).toBeNull();
			expect(memberIsPro()).toBe(false);
		});

		it("keeps Pro when a manager-sponsored seat remains", async () => {
			await turnSeatOff([{ stripeSubscriptionId: null }]);

			expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_this_org");
			expect(memberIsPro()).toBe(true);
		});

		it("moves Pro onto a remaining seat the organization owner pays for", async () => {
			await turnSeatOff([{ stripeSubscriptionId: "sub_other" }]);

			expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_other");
			expect(memberIsPro()).toBe(true);
		});

		it("prefers a paid seat when sponsored and paid seats both remain", async () => {
			await turnSeatOff([
				{ stripeSubscriptionId: null },
				{ stripeSubscriptionId: "sub_other" },
			]);

			expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_other");
			expect(memberIsPro()).toBe(true);
		});

		it("locks the member row and then the user row inside the transaction", async () => {
			await turnSeatOff([{ stripeSubscriptionId: "sub_other" }]);

			expect(database.transaction).toHaveBeenCalledTimes(1);
			expect(database.select).toHaveBeenCalledTimes(3);
			expect(lockRows.mock.calls).toEqual([
				["update", tables.organizationMembers],
				["update", tables.users],
			]);
			expect(reads.find((read) => !read.locked)).toEqual({
				table: tables.organizationMembers,
				joined: true,
				locked: false,
			});
		});

		it("does nothing when the seat is already off", async () => {
			mocks.selectResults = [
				[{ id: "member", userId: "teammate", hasProSeat: false }],
			];

			await toggle(false);

			expect(updates).toEqual([]);
			expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_this_org");
		});
	});

	describe("turning a seat on", () => {
		const owner = {
			id: "owner",
			inviteQuota: 3,
			stripeSubscriptionId: "sub_owner",
			stripeSubscriptionStatus: "active",
		};
		const members = [
			{ id: "owner-member", userId: "owner", hasProSeat: false },
			{ id: "member", userId: "teammate", hasProSeat: false },
		];

		it("assigns the seat and points Pro at the seat provider", async () => {
			mocks.user.thirdPartyStripeSubscriptionId = null;
			mocks.selectResults = [
				[{ id: "member", userId: "teammate", hasProSeat: false }],
				members,
				[owner],
			];

			await toggle(true);

			expect(updates).toEqual([
				{ table: tables.organizationMembers, value: { hasProSeat: true } },
				{
					table: tables.users,
					value: { thirdPartyStripeSubscriptionId: "sub_owner" },
				},
			]);
			expect(database.select).toHaveBeenCalledTimes(3);
			expect(lockRows).toHaveBeenCalledTimes(2);
			expect(memberIsPro()).toBe(true);
		});

		it("refuses when no Pro seats remain", async () => {
			mocks.user.thirdPartyStripeSubscriptionId = null;
			mocks.selectResults = [
				[{ id: "member", userId: "teammate", hasProSeat: false }],
				members,
				[{ ...owner, inviteQuota: 1 }],
			];

			await expect(toggle(true)).rejects.toThrow("No Pro seats remaining");
			expect(updates).toEqual([]);
		});

		it("refuses without an active subscription to sponsor the seat", async () => {
			mocks.user.thirdPartyStripeSubscriptionId = null;
			mocks.selectResults = [
				[{ id: "member", userId: "teammate", hasProSeat: false }],
				members,
				[{ ...owner, stripeSubscriptionStatus: "canceled" }],
			];

			await expect(toggle(true)).rejects.toThrow(
				"An active Cap Pro subscription is required",
			);
			expect(updates).toEqual([]);
		});
	});
});
