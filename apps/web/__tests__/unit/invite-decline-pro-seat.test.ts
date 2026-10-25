import { userIsPro } from "@cap/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	selectResults: [] as unknown[][],
	user: { thirdPartyStripeSubscriptionId: null as string | null },
}));

const tables = vi.hoisted(() => ({
	organizationInvites: {
		id: "inviteId",
		invitedEmail: "invitedEmail",
		organizationId: "inviteOrgId",
	},
	organizationMembers: {
		id: "memberId",
		userId: "memberUserId",
		organizationId: "memberOrgId",
		hasProSeat: "hasProSeat",
	},
	organizations: { id: "orgId", ownerId: "ownerId" },
	spaceMembers: { userId: "spaceUserId", spaceId: "spaceId" },
	spaces: { id: "spaceId", organizationId: "spaceOrgId" },
	users: {
		id: "userId",
		stripeSubscriptionId: "subscriptionId",
		thirdPartyStripeSubscriptionId: "thirdPartySubscriptionId",
	},
}));

const lockRows = vi.fn();
const reads: { table: unknown; joined: boolean; locked: boolean }[] = [];
const deletes: unknown[] = [];

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
	delete: vi.fn((table: unknown) => {
		deletes.push(table);
		return { where: async () => [{ affectedRows: 1 }] };
	}),
	update: vi.fn((table: unknown) => ({
		set: (value: Record<string, unknown>) => {
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
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/schema", () => tables);

async function declineProSeat(
	remainingSeats: { stripeSubscriptionId: string | null }[],
) {
	mocks.selectResults = [
		[
			{
				id: "invite-1",
				invitedEmail: "invitee@example.com",
				organizationId: "org-1",
			},
		],
		[{ id: "member-1", hasProSeat: true }],
		[{ id: "user-1" }],
		remainingSeats,
		[],
		[],
	];
	const { POST } = await import("@/app/api/invite/decline/route");
	return POST(
		new Request("https://cap.test/api/invite/decline", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ inviteId: "invite-1" }),
		}) as unknown as import("next/server").NextRequest,
	);
}

function userIsStillPro() {
	return userIsPro({ stripeSubscriptionStatus: null, ...mocks.user });
}

describe("POST /api/invite/decline with a Pro seat", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		deletes.length = 0;
		reads.length = 0;
		mocks.user.thirdPartyStripeSubscriptionId = "sub_org_1";
		mocks.getCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "invitee@example.com",
			activeOrganizationId: null,
			defaultOrgId: null,
		});
	});

	it("clears Pro when the declined seat was the last one", async () => {
		const response = await declineProSeat([]);

		expect(response.status).toBe(200);
		expect(deletes).toEqual([
			tables.organizationMembers,
			tables.organizationInvites,
		]);
		expect(mocks.user.thirdPartyStripeSubscriptionId).toBeNull();
		expect(userIsStillPro()).toBe(false);
	});

	it("keeps Pro when a manager-sponsored seat remains", async () => {
		const response = await declineProSeat([{ stripeSubscriptionId: null }]);

		expect(response.status).toBe(200);
		expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_org_1");
		expect(userIsStillPro()).toBe(true);
	});

	it("moves Pro onto a remaining paid seat", async () => {
		const response = await declineProSeat([
			{ stripeSubscriptionId: null },
			{ stripeSubscriptionId: "sub_other" },
		]);

		expect(response.status).toBe(200);
		expect(deletes).toEqual([
			tables.organizationMembers,
			tables.organizationInvites,
		]);
		expect(mocks.user.thirdPartyStripeSubscriptionId).toBe("sub_other");
		expect(userIsStillPro()).toBe(true);
	});

	it("locks the invite, the membership and the user row", async () => {
		await declineProSeat([{ stripeSubscriptionId: "sub_other" }]);

		expect(lockRows.mock.calls).toEqual([
			["update", tables.organizationInvites],
			["update", tables.organizationMembers],
			["update", tables.users],
		]);
	});

	it("reads the remaining seats before any other plain read", async () => {
		await declineProSeat([{ stripeSubscriptionId: "sub_other" }]);

		expect(reads.find((read) => !read.locked)).toEqual({
			table: tables.organizationMembers,
			joined: true,
			locked: false,
		});
	});
});
