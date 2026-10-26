import { userIsPro } from "@cap/utils";
import { Organisation } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	requireManager: vi.fn(),
	selectResults: [] as unknown[][],
	user: { thirdPartyStripeSubscriptionId: "sub_owner" as string | null },
}));

const tables = {
	organizationMembers: {
		id: "memberId",
		userId: "memberUserId",
		organizationId: "memberOrgId",
		role: "role",
		hasProSeat: "hasProSeat",
	},
	organizationInvites: { organizationId: "inviteOrgId", invitedEmail: "email" },
	spaceMembers: { userId: "spaceUserId", spaceId: "spaceId" },
	spaces: { id: "spaceId", organizationId: "spaceOrgId" },
	organizations: { id: "orgId", ownerId: "ownerId" },
	users: {
		id: "userId",
		email: "email",
		stripeSubscriptionId: "subscriptionId",
	},
};

const lockRows = vi.fn();

type SelectQuery = Promise<unknown[]> & {
	from(): SelectQuery;
	innerJoin(): SelectQuery;
	where(): SelectQuery;
	limit(): SelectQuery;
	for(mode: string): SelectQuery;
};

function selectQuery() {
	const query: SelectQuery = Object.assign(
		Promise.resolve(mocks.selectResults.shift() ?? []),
		{
			from: () => query,
			innerJoin: () => query,
			where: () => query,
			limit: () => query,
			for: (mode: string) => {
				lockRows(mode);
				return query;
			},
		},
	);
	return query;
}

const updateSet = vi.fn(
	(value: { thirdPartyStripeSubscriptionId?: string | null }) => {
		if ("thirdPartyStripeSubscriptionId" in value) {
			mocks.user.thirdPartyStripeSubscriptionId =
				value.thirdPartyStripeSubscriptionId ?? null;
		}
		return { where: async () => [{ affectedRows: 1 }] };
	},
);

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
vi.mock("@cap/database/schema", () => tables);
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
			},
		],
		[{ id: "teammate" }],
		remainingSeats,
		[],
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
		mocks.getCurrentUser.mockResolvedValue({ id: "owner" });
		mocks.requireManager.mockResolvedValue({ ownerId: "owner", role: "owner" });
	});

	it("revokes Pro access when the removed seat was the user's last seat", async () => {
		await removeSeat([]);

		expect(lockRows).toHaveBeenCalledWith("update");
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
