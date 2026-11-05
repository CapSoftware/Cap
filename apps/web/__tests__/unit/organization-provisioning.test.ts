import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import {
	type AnyMySqlColumn,
	MySqlDialect,
	type MySqlTable,
} from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
	rows: new Map<MySqlTable, Row[]>(),
	sequence: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));
vi.mock("@cap/database/loops/queue", () => ({ enqueueLoopsSync: vi.fn() }));
vi.mock("@cap/database/helpers", () => ({
	nanoIdLength: 15,
	nanoId: () => `provisioned-${++mocks.sequence}`,
}));

function matchesRow(condition: SQL, row: Row) {
	const query = new MySqlDialect().sqlToQuery(condition);
	const columns = [...query.sql.matchAll(/`[^`]+`\.`([^`]+)` = \?/g)];
	if (columns.length !== query.params.length) {
		throw new Error(`Unsupported predicate: ${query.sql}`);
	}
	return columns.every(
		(column, index) => row[column[1] ?? ""] === query.params[index],
	);
}

function rowsFor(table: MySqlTable) {
	const rows = mocks.rows.get(table);
	if (!rows) throw new Error("Unexpected table");
	return rows;
}

const database = {
	select: (columns?: Record<string, AnyMySqlColumn>) => ({
		from: (table: MySqlTable) => ({
			where: (condition: SQL) => {
				const rows = rowsFor(table)
					.filter((row) => matchesRow(condition, row))
					.map((row) =>
						columns
							? Object.fromEntries(
									Object.entries(columns).map(([key, column]) => [
										key,
										row[column.name],
									]),
								)
							: { ...row },
					);
				return Object.assign(Promise.resolve(rows), {
					limit: async (count: number) => rows.slice(0, count),
				});
			},
		}),
	}),
	insert: (table: MySqlTable) => ({
		values: async (row: Row) => {
			rowsFor(table).push({ hasProSeat: false, ...row });
		},
	}),
	update: (table: MySqlTable) => ({
		set: (patch: Row) => ({
			where: async (condition: SQL) => {
				for (const row of rowsFor(table)) {
					if (matchesRow(condition, row)) Object.assign(row, patch);
				}
			},
		}),
	}),
};

vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async <T>(run: (tx: typeof database) => Promise<T>) =>
			run(database),
	}),
}));

const organizationId = Organisation.OrganisationId.make("org");
const ownerId = User.UserId.make("owner");

function provision() {
	return provisionOrganizationInvitee({
		organizationId,
		email: "invitee@example.com",
		invitedByUserId: ownerId,
		role: "member",
	});
}

describe("invitee provisioning Pro seats", () => {
	beforeEach(() => {
		mocks.sequence = 0;
		mocks.rows = new Map<MySqlTable, Row[]>([
			[
				users,
				[
					{
						id: ownerId,
						inviteQuota: 1,
						stripeSubscriptionId: "sub_owner",
						stripeSubscriptionStatus: "active",
					},
				],
			],
			[organizations, [{ id: organizationId, ownerId }]],
			[
				organizationMembers,
				[
					{
						id: "owner-membership",
						organizationId,
						userId: ownerId,
						hasProSeat: false,
					},
				],
			],
			[organizationInvites, []],
		]);
	});

	it.each([false, true])(
		"reserves the owner's seat when its membership flag is %s",
		async (hasProSeat) => {
			Object.assign(rowsFor(organizationMembers)[0] ?? {}, { hasProSeat });

			const result = await provision();

			expect(result).toMatchObject({ memberCreated: true, hasProSeat: false });
			expect(
				rowsFor(organizationMembers).find((row) => row.id === result.memberId)
					?.hasProSeat,
			).toBe(false);
			expect(
				rowsFor(users).find((row) => row.id === result.userId)
					?.thirdPartyStripeSubscriptionId,
			).toBeUndefined();
		},
	);

	it("assigns only the remaining purchased seat across successive invitees", async () => {
		Object.assign(rowsFor(users)[0] ?? {}, { inviteQuota: 2 });

		const first = await provision();
		const second = await provisionOrganizationInvitee({
			organizationId,
			email: "second@example.com",
			invitedByUserId: ownerId,
			role: "admin",
		});

		expect(first.hasProSeat).toBe(true);
		expect(
			rowsFor(users).find((row) => row.id === first.userId)
				?.thirdPartyStripeSubscriptionId,
		).toBe("sub_owner");
		expect(second).toMatchObject({ memberCreated: true, hasProSeat: false });
		expect(
			rowsFor(organizationMembers).filter((row) => row.hasProSeat),
		).toHaveLength(1);
	});

	it("keeps an existing invitee's assigned seat without duplicating membership", async () => {
		Object.assign(rowsFor(users)[0] ?? {}, { inviteQuota: 2 });
		const first = await provision();

		expect(await provision()).toMatchObject({
			userId: first.userId,
			memberId: first.memberId,
			memberCreated: false,
			hasProSeat: true,
		});
		expect(rowsFor(organizationMembers)).toHaveLength(2);
		expect(rowsFor(organizationInvites)).toHaveLength(1);
	});

	it("does not grant Pro from an inactive subscription", async () => {
		Object.assign(rowsFor(users)[0] ?? {}, {
			inviteQuota: 10,
			stripeSubscriptionStatus: "canceled",
		});

		expect(await provision()).toMatchObject({
			memberCreated: true,
			hasProSeat: false,
		});
	});
});
