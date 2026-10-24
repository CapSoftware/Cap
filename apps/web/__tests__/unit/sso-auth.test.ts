import {
	getSsoEmailDomain,
	normalizeSsoDomain,
	provisionSsoMembership,
	type SsoAuthContext,
	type ValidatedSsoIdentity,
	validateSsoSignIn,
} from "@cap/database/auth/sso";
import {
	createSsoLoginIntent,
	SSO_INTENT_MAX_AGE,
	type SsoLoginIntent,
	verifySsoLoginIntent,
} from "@cap/database/auth/sso-state";
import * as Db from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { getTableName, is, type SQL } from "drizzle-orm";
import {
	type AnyMySqlColumn,
	MySqlDialect,
	MySqlTable,
} from "drizzle-orm/mysql-core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getOrganization: vi.fn(),
	getConnection: vi.fn(),
	stripe: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WORKOS_CLIENT_ID: "client_test",
		WORKOS_API_KEY: "workos_test_secret",
	}),
}));
vi.mock("@workos-inc/node", () => ({
	WorkOS: class {
		organizations = { getOrganization: mocks.getOrganization };
		sso = { getConnection: mocks.getConnection };
	},
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	STRIPE_AVAILABLE: () => true,
	stripe: mocks.stripe,
}));

type Row = Record<string, unknown>;
type RowScope = Record<string, Row>;
type Selection = Record<string, MySqlTable | AnyMySqlColumn>;

function matchesRow(condition: SQL | undefined, scope: RowScope) {
	if (!condition) return true;
	const query = new MySqlDialect().sqlToQuery(condition);
	let parameterIndex = 0;
	return query.sql
		.replaceAll("(", "")
		.replaceAll(")", "")
		.split(" and ")
		.every((clause) => {
			const match =
				/^`([^`]+)`\.`([^`]+)` (is null|= \?|= `([^`]+)`\.`([^`]+)`)$/.exec(
					clause,
				);
			if (!match?.[1] || !match[2]) {
				throw new Error(`Unsupported query predicate: ${clause}`);
			}
			const value = scope[match[1]]?.[match[2]];
			if (match[3] === "is null") return value == null;
			if (match[3] === "= ?") return value === query.params[parameterIndex++];
			if (!match[4] || !match[5]) throw new Error("Invalid joined predicate");
			return value === scope[match[4]]?.[match[5]];
		});
}

function createDatabase(seed: Map<MySqlTable, Row[]>) {
	const tables = new Map(seed);
	const hooks: { beforeUpdate?: (table: MySqlTable) => void } = {};
	const rows = (table: MySqlTable) => {
		const result = tables.get(table);
		if (!result) throw new Error("Unexpected table");
		return result;
	};
	class SelectQuery {
		private table: MySqlTable | undefined;
		private condition: SQL | undefined;
		private rowLimit = Number.POSITIVE_INFINITY;
		private joins: { table: MySqlTable; condition: SQL | undefined }[] = [];

		constructor(
			private selection?: Selection,
			private distinct = false,
		) {}

		from(table: MySqlTable) {
			this.table = table;
			return this;
		}

		innerJoin(table: MySqlTable, condition: SQL | undefined) {
			this.joins.push({ table, condition });
			return this;
		}

		where(condition: SQL | undefined) {
			this.condition = condition;
			return this;
		}

		limit(count: number) {
			this.rowLimit = count;
			return Promise.resolve().then(() => this.execute());
		}

		for() {
			return Promise.resolve().then(() => this.execute());
		}

		private execute() {
			const table = this.table;
			if (!table) throw new Error("Missing query table");
			const tableName = getTableName(table);
			let scopes: RowScope[] = rows(table).map((row) => ({ [tableName]: row }));
			for (const join of this.joins) {
				scopes = scopes.flatMap((scope) =>
					rows(join.table)
						.map((row) => ({ ...scope, [getTableName(join.table)]: row }))
						.filter((joined) => matchesRow(join.condition, joined)),
				);
			}
			const selected = scopes
				.filter((scope) => matchesRow(this.condition, scope))
				.map((scope) =>
					this.selection
						? Object.fromEntries(
								Object.entries(this.selection).map(([key, field]) => [
									key,
									is(field, MySqlTable)
										? { ...scope[getTableName(field)] }
										: scope[getTableName(field.table)]?.[field.name],
								]),
							)
						: { ...scope[tableName] },
				);
			const result = this.distinct
				? [
						...new Map(
							selected.map((row) => [JSON.stringify(row), row]),
						).values(),
					]
				: selected;
			return result.slice(0, this.rowLimit);
		}
	}

	const client = {
		select: vi.fn((selection?: Selection) => new SelectQuery(selection)),
		selectDistinct: vi.fn(
			(selection?: Selection) => new SelectQuery(selection, true),
		),
		insert: vi.fn((table: MySqlTable) => ({
			values: (value: Row) => {
				const insert = (update?: Row) => {
					const existing = rows(table).find(
						(row) =>
							row.id === value.id ||
							(table === Db.users && row.email === value.email),
					);
					if (existing) {
						if (!update) throw new Error("Duplicate row");
						Object.assign(existing, update);
					} else {
						rows(table).push({
							emailVerified: null,
							defaultOrgId: null,
							onboardingSteps: null,
							onboarding_completed_at: null,
							...value,
						});
					}
				};
				let update: Row | undefined;
				const pending = Promise.resolve().then(() => insert(update));
				return Object.assign(pending, {
					onDuplicateKeyUpdate: ({ set }: { set: Row }) => {
						update = set;
						return pending;
					},
				});
			},
		})),
		update: vi.fn((table: MySqlTable) => ({
			set: (patch: Row) => ({
				where: async (condition: SQL | undefined) => {
					hooks.beforeUpdate?.(table);
					for (const row of rows(table)) {
						if (matchesRow(condition, { [getTableName(table)]: row })) {
							Object.assign(row, patch);
						}
					}
				},
			}),
		})),
		transaction: vi.fn(
			async (callback: (database: MySql2Database) => Promise<unknown>) => {
				const snapshot = new Map(
					[...tables].map(([table, records]) => [
						table,
						structuredClone(records),
					]),
				);
				try {
					return await callback(client as unknown as MySql2Database);
				} catch (error) {
					for (const [table, records] of snapshot) tables.set(table, records);
					throw error;
				}
			},
		),
	};
	return { client, rows, hooks };
}

const USER_ID = User.UserId.make("sso-user");
const OTHER_USER_ID = User.UserId.make("other-user");
const ORGANIZATION_ID = Organisation.OrganisationId.make("cap-org");
const OTHER_ORGANIZATION_ID = Organisation.OrganisationId.make("other-org");
const PROFILE = {
	id: "prof_01A",
	organization_id: "org_01A",
	connection_id: "conn_01A",
	email: "alex@company.example",
};
const IDENTITY: ValidatedSsoIdentity = {
	organizationId: ORGANIZATION_ID,
	workosOrganizationId: PROFILE.organization_id,
	connectionId: PROFILE.connection_id,
	profileId: PROFILE.id,
	email: PROFILE.email,
};
const INTENT: SsoLoginIntent = {
	version: 1,
	organizationId: ORGANIZATION_ID,
	workosOrganizationId: PROFILE.organization_id,
	connectionId: PROFILE.connection_id,
	actorId: null,
	issuedAt: 1,
	nonce: "a".repeat(32),
};
const CONTEXT: SsoAuthContext = { intent: INTENT, actorId: null };

function actorContext(actorId: string): SsoAuthContext {
	return { intent: { ...INTENT, actorId }, actorId };
}

function makeFixture() {
	const database = createDatabase(
		new Map<MySqlTable, Row[]>([
			[
				Db.users,
				[
					{
						id: USER_ID,
						email: PROFILE.email,
						name: "Alex",
						activeOrganizationId: OTHER_ORGANIZATION_ID,
						defaultOrgId: OTHER_ORGANIZATION_ID,
						emailVerified: null,
						onboarding_completed_at: null,
						onboardingSteps: { welcome: false },
					},
					{
						id: OTHER_USER_ID,
						email: "someone@other.example",
						activeOrganizationId: OTHER_ORGANIZATION_ID,
					},
				],
			],
			[
				Db.organizations,
				[
					{
						id: ORGANIZATION_ID,
						ownerId: OTHER_USER_ID,
						workosOrganizationId: PROFILE.organization_id,
						workosConnectionId: PROFILE.connection_id,
						tombstoneAt: null,
					},
					{
						id: OTHER_ORGANIZATION_ID,
						ownerId: OTHER_USER_ID,
						workosOrganizationId: "org_01B",
						workosConnectionId: "conn_01B",
						tombstoneAt: null,
					},
				],
			],
			[
				Db.organizationSso,
				[
					{
						organizationId: ORGANIZATION_ID,
						status: "active",
						paidThrough: new Date("2099-01-01T00:00:00.000Z"),
					},
					{
						organizationId: OTHER_ORGANIZATION_ID,
						status: "active",
						paidThrough: new Date("2099-01-01T00:00:00.000Z"),
					},
				],
			],
			[
				Db.organizationInvites,
				[
					{
						id: "same-org-invite",
						organizationId: ORGANIZATION_ID,
						invitedEmail: PROFILE.email,
						status: "pending",
					},
					{
						id: "other-org-invite",
						organizationId: OTHER_ORGANIZATION_ID,
						invitedEmail: PROFILE.email,
						status: "pending",
					},
					{
						id: "other-email-invite",
						organizationId: ORGANIZATION_ID,
						invitedEmail: "someone@company.example",
						status: "pending",
					},
				],
			],
			[Db.accounts, []],
			[Db.organizationMembers, []],
		]),
	);
	const workosOrganization = {
		id: PROFILE.organization_id,
		domains: [{ domain: "company.example", state: "verified" }],
	};
	const connection = {
		id: PROFILE.connection_id,
		organizationId: PROFILE.organization_id,
		state: "active",
	};
	mocks.db.mockReturnValue(database.client);
	mocks.getOrganization.mockResolvedValue(workosOrganization);
	mocks.getConnection.mockResolvedValue(connection);
	const row = (table: MySqlTable, id: string, column = "id") => {
		const record = database.rows(table).find((record) => record[column] === id);
		if (!record) throw new Error("Fixture row was not found");
		return record;
	};
	return {
		...database,
		workosOrganization,
		connection,
		get user() {
			return row(Db.users, USER_ID);
		},
		get organization() {
			return row(Db.organizations, ORGANIZATION_ID);
		},
		get billing() {
			return row(Db.organizationSso, ORGANIZATION_ID, "organizationId");
		},
		link(userId = USER_ID) {
			database.rows(Db.accounts).push({
				id: `account-${database.rows(Db.accounts).length}`,
				userId,
				provider: "workos",
				providerAccountId: PROFILE.id,
			});
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getOrganization.mockReset();
	mocks.getConnection.mockReset();
	mocks.stripe.mockReset().mockImplementation(() => {
		throw new Error("SSO must not bootstrap Stripe billing");
	});
});

describe("SSO identity validation", () => {
	it("validates the exact tenant and verified profile without granting membership", async () => {
		const fixture = makeFixture();

		await expect(
			validateSsoSignIn(
				{ ...PROFILE, email: " Alex@Company.Example " },
				PROFILE.id,
				CONTEXT,
			),
		).resolves.toEqual(IDENTITY);

		expect(mocks.getOrganization).toHaveBeenCalledWith(PROFILE.organization_id);
		expect(mocks.getConnection).toHaveBeenCalledWith(PROFILE.connection_id);
		expect(fixture.client.transaction).not.toHaveBeenCalled();
		expect(fixture.client.insert).not.toHaveBeenCalled();
		expect(fixture.client.update).not.toHaveBeenCalled();
	});

	it.each([undefined, { intent: null, actorId: null }])(
		"rejects a missing server intent",
		async (context) => {
			makeFixture();
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, context),
			).rejects.toThrow("expired");
			expect(mocks.db).not.toHaveBeenCalled();
			expect(mocks.getOrganization).not.toHaveBeenCalled();
		},
	);

	it("rejects an intent when the browser actor changed", async () => {
		makeFixture();
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, {
				intent: { ...INTENT, actorId: USER_ID },
				actorId: OTHER_USER_ID,
			}),
		).rejects.toThrow("expired");
		expect(mocks.db).not.toHaveBeenCalled();
	});

	it("rejects expired intent after the request boundary verifies its signature", async () => {
		makeFixture();
		const now = Date.UTC(2026, 8, 2);
		const value = createSsoLoginIntent(INTENT, "secret", now);
		const intent = verifySsoLoginIntent(
			value,
			"secret",
			now + SSO_INTENT_MAX_AGE * 1000,
		);

		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, { intent, actorId: null }),
		).rejects.toThrow("expired");
		expect(mocks.getOrganization).not.toHaveBeenCalled();
	});

	it.each([
		{ organization_id: "org_01B" },
		{ connection_id: "conn_01B" },
		{ id: "prof_01B" },
		{ email: null },
	])(
		"rejects profile fields that do not match the tenant intent: %j",
		async (override) => {
			makeFixture();
			await expect(
				validateSsoSignIn({ ...PROFILE, ...override }, PROFILE.id, CONTEXT),
			).rejects.toThrow();
			expect(mocks.db).not.toHaveBeenCalled();
		},
	);

	it.each([null, undefined, "profile", 42])(
		"rejects malformed profile %j",
		async (profile) => {
			makeFixture();
			await expect(
				validateSsoSignIn(profile, PROFILE.id, CONTEXT),
			).rejects.toThrow("profile");
		},
	);

	it.each([
		"no-at",
		"a@@company.example",
		"a b@company.example",
		"a@company.example/path",
	])("rejects malformed email %s", async (email) => {
		makeFixture();
		await expect(
			validateSsoSignIn({ ...PROFILE, email }, PROFILE.id, CONTEXT),
		).rejects.toThrow("email");
		expect(mocks.getOrganization).not.toHaveBeenCalled();
	});

	it.each(["unpaid", "canceled", "incomplete", "past_due", "active"])(
		"denies %s billing with no remaining paid access",
		async (status) => {
			const fixture = makeFixture();
			Object.assign(fixture.billing, { status, paidThrough: new Date(0) });
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
			).rejects.toThrow("not available");
			expect(mocks.getOrganization).not.toHaveBeenCalled();
		},
	);

	it("rejects a tombstoned Cap organization", async () => {
		const fixture = makeFixture();
		fixture.organization.tombstoneAt = new Date();
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
		).rejects.toThrow("not available");
	});

	it("rejects an unregistered organization even when the other tenant is paid", async () => {
		const fixture = makeFixture();
		fixture.rows(Db.organizationSso).splice(0, 1);
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
		).rejects.toThrow("not available");
	});

	it("rejects an organization whose WorkOS association changed", async () => {
		const fixture = makeFixture();
		fixture.organization.workosOrganizationId = "org_01B";
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
		).rejects.toThrow("no longer connected");
	});

	it.each(["pending", "inactive", "deleted"])(
		"rejects an %s connection",
		async (state) => {
			const fixture = makeFixture();
			fixture.connection.state = state;
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
			).rejects.toThrow("not verified");
		},
	);

	it.each(["getOrganization", "getConnection"] as const)(
		"fails closed when WorkOS %s fails",
		async (method) => {
			const fixture = makeFixture();
			mocks[method].mockRejectedValueOnce(
				new Error("WorkOS resource not found"),
			);
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
			).rejects.toThrow("not found");
			expect(fixture.client.insert).not.toHaveBeenCalled();
		},
	);

	it.each(["organization", "connection"] as const)(
		"rejects a mismatched WorkOS %s response",
		async (resource) => {
			const fixture = makeFixture();
			if (resource === "organization")
				fixture.workosOrganization.id = "org_01B";
			else fixture.connection.organizationId = "org_01B";
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
			).rejects.toThrow("not verified");
		},
	);

	it.each(["pending", "unverified"])(
		"does not trust a domain in %s state",
		async (state) => {
			const fixture = makeFixture();
			fixture.workosOrganization.domains = [
				{ domain: "company.example", state },
			];
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
			).rejects.toThrow("not verified");
		},
	);

	it("blocks an IdP from asserting an email outside its verified domains", async () => {
		const fixture = makeFixture();
		fixture.workosOrganization.domains = [
			{ domain: "attacker.example", state: "verified" },
		];
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
		).rejects.toThrow("not verified");
		expect(fixture.client.insert).not.toHaveBeenCalled();
	});

	it("does not grant verified parent-domain trust to subdomains", async () => {
		makeFixture();
		await expect(
			validateSsoSignIn(
				{ ...PROFILE, email: "alex@sub.company.example" },
				PROFILE.id,
				CONTEXT,
			),
		).rejects.toThrow("not verified");
	});

	it("rejects an already-linked profile whose email changed", async () => {
		const fixture = makeFixture();
		fixture.link();
		fixture.user.email = "previous@company.example";
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
		).rejects.toThrow("different account");
	});

	it("rejects conflicting profile links hidden behind duplicate account rows", async () => {
		const fixture = makeFixture();
		fixture.link();
		fixture.link();
		fixture.link(OTHER_USER_ID);
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT),
		).rejects.toThrow("different account");
	});

	it.each([OTHER_USER_ID, "missing-user"])(
		"rejects a mismatched browser account %s",
		async (actorId) => {
			makeFixture();
			await expect(
				validateSsoSignIn(PROFILE, PROFILE.id, actorContext(actorId)),
			).rejects.toThrow("Sign out");
		},
	);

	it("allows the same browser account after validating its stored email", async () => {
		const fixture = makeFixture();
		fixture.link();
		await expect(
			validateSsoSignIn(PROFILE, PROFILE.id, actorContext(USER_ID)),
		).resolves.toEqual(IDENTITY);
	});
});

describe("SSO membership provisioning", () => {
	it("adds only the authenticated organization and accepts only its matching invitation", async () => {
		const fixture = makeFixture();
		fixture.link();

		await provisionSsoMembership(USER_ID, IDENTITY);

		expect(fixture.rows(Db.organizationMembers)).toEqual([
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORGANIZATION_ID,
				role: "member",
				hasProSeat: false,
			}),
		]);
		expect(
			fixture
				.rows(Db.organizationInvites)
				.map(({ id, status }) => ({ id, status })),
		).toEqual([
			{ id: "same-org-invite", status: "accepted" },
			{ id: "other-org-invite", status: "pending" },
			{ id: "other-email-invite", status: "pending" },
		]);
		expect(fixture.user).toMatchObject({
			activeOrganizationId: ORGANIZATION_ID,
			defaultOrgId: OTHER_ORGANIZATION_ID,
			emailVerified: expect.any(Date),
			onboarding_completed_at: expect.any(Date),
			onboardingSteps: {
				welcome: true,
				organizationSetup: true,
				customDomain: true,
				inviteTeam: true,
				download: true,
			},
		});
		expect(
			fixture.rows(Db.users).find((user) => user.id === OTHER_USER_ID)
				?.activeOrganizationId,
		).toBe(OTHER_ORGANIZATION_ID);
		expect(mocks.stripe).not.toHaveBeenCalled();
	});

	it.each(["owner", "admin", "member"])(
		"preserves the existing %s role and Pro seat",
		async (role) => {
			const fixture = makeFixture();
			fixture.link();
			const member = {
				id: "member-existing",
				userId: USER_ID,
				organizationId: ORGANIZATION_ID,
				role,
				hasProSeat: true,
			};
			fixture.rows(Db.organizationMembers).push({ ...member });

			await provisionSsoMembership(USER_ID, IDENTITY);
			await provisionSsoMembership(USER_ID, IDENTITY);

			expect(fixture.rows(Db.organizationMembers)).toEqual([member]);
			expect(fixture.client.insert).not.toHaveBeenCalled();
		},
	);

	it("restores a missing membership with the authoritative owner's role", async () => {
		const fixture = makeFixture();
		fixture.organization.ownerId = USER_ID;
		fixture.link();

		await provisionSsoMembership(USER_ID, IDENTITY);
		await provisionSsoMembership(USER_ID, IDENTITY);

		expect(fixture.rows(Db.organizationMembers)).toEqual([
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORGANIZATION_ID,
				role: "owner",
				hasProSeat: false,
			}),
		]);
		expect(fixture.client.insert).toHaveBeenCalledTimes(1);
	});

	it("does not mistake membership in another organization for this one", async () => {
		const fixture = makeFixture();
		fixture.link();
		const previous = {
			id: "other-member",
			userId: USER_ID,
			organizationId: OTHER_ORGANIZATION_ID,
			role: "admin",
			hasProSeat: true,
		};
		fixture.rows(Db.organizationMembers).push({ ...previous });

		await provisionSsoMembership(USER_ID, IDENTITY);

		expect(fixture.rows(Db.organizationMembers)).toContainEqual(previous);
		expect(fixture.rows(Db.organizationMembers)).toContainEqual(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORGANIZATION_ID,
				role: "member",
				hasProSeat: false,
			}),
		);
	});

	it("sets the SSO organization as default only when no default exists", async () => {
		const fixture = makeFixture();
		fixture.link();
		fixture.user.defaultOrgId = null;
		await provisionSsoMembership(USER_ID, IDENTITY);
		expect(fixture.user.defaultOrgId).toBe(ORGANIZATION_ID);
	});

	it("does not reset existing verification and onboarding dates", async () => {
		const fixture = makeFixture();
		fixture.link();
		const before = new Date("2020-01-01T00:00:00.000Z");
		Object.assign(fixture.user, {
			emailVerified: before,
			onboarding_completed_at: before,
		});
		await provisionSsoMembership(USER_ID, IDENTITY);
		expect(fixture.user.emailVerified).toEqual(before);
		expect(fixture.user.onboarding_completed_at).toEqual(before);
	});

	it("rejects payment revocation between validation and provisioning", async () => {
		const fixture = makeFixture();
		fixture.link();
		const identity = await validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT);
		fixture.billing.status = "canceled";

		await expect(provisionSsoMembership(USER_ID, identity)).rejects.toThrow(
			"no longer available",
		);
		expect(fixture.client.insert).not.toHaveBeenCalled();
		expect(fixture.client.update).not.toHaveBeenCalled();
	});

	it.each(["deleted", "disconnected", "changed-email"])(
		"fails closed after %s during sign-in",
		async (change) => {
			const fixture = makeFixture();
			fixture.link();
			if (change === "deleted") fixture.organization.tombstoneAt = new Date();
			else if (change === "disconnected")
				fixture.organization.workosOrganizationId = "org_01B";
			else fixture.user.email = "changed@company.example";
			await expect(provisionSsoMembership(USER_ID, IDENTITY)).rejects.toThrow(
				"no longer available",
			);
			expect(fixture.client.insert).not.toHaveBeenCalled();
		},
	);

	it.each([
		"missing",
		"other-user",
		"other-profile",
		"ambiguous",
		"orphaned-conflict",
	])("rejects a %s linked account", async (link) => {
		const fixture = makeFixture();
		if (link === "other-user") fixture.link(OTHER_USER_ID);
		if (link === "ambiguous" || link === "orphaned-conflict") {
			fixture.link();
			fixture.link();
			fixture.link(
				link === "ambiguous" ? OTHER_USER_ID : User.UserId.make("deleted-user"),
			);
		}
		if (link === "other-profile") {
			fixture.rows(Db.accounts).push({
				id: "another-profile",
				userId: USER_ID,
				provider: "workos",
				providerAccountId: "prof_01B",
			});
		}
		await expect(provisionSsoMembership(USER_ID, IDENTITY)).rejects.toThrow(
			"not linked",
		);
		expect(fixture.client.insert).not.toHaveBeenCalled();
		expect(fixture.client.update).not.toHaveBeenCalled();
	});

	it("rolls back membership and invitation updates when the user update fails", async () => {
		const fixture = makeFixture();
		fixture.link();
		fixture.hooks.beforeUpdate = (table) => {
			if (table === Db.users) throw new Error("User update failed");
		};
		await expect(provisionSsoMembership(USER_ID, IDENTITY)).rejects.toThrow(
			"User update failed",
		);
		expect(fixture.rows(Db.organizationMembers)).toEqual([]);
		expect(
			fixture
				.rows(Db.organizationInvites)
				.every((invite) => invite.status === "pending"),
		).toBe(true);
		expect(fixture.user.activeOrganizationId).toBe(OTHER_ORGANIZATION_ID);
	});
});

describe("SSO adapter provisioning", () => {
	it("creates, links, then joins a new user without a personal organization or Stripe bootstrap", async () => {
		const fixture = makeFixture();
		fixture.rows(Db.users).splice(0, 1);
		fixture.rows(Db.organizationInvites).splice(0);
		const identity = await validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT);
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{
				getSsoIdentity: () => identity,
			},
		);
		if (!adapter.createUser || !adapter.linkAccount)
			throw new Error("Missing adapter methods");
		const user = await adapter.createUser({
			email: PROFILE.email,
			name: "Alex",
			emailVerified: null,
		});

		expect(fixture.rows(Db.organizations)).toHaveLength(2);
		expect(fixture.rows(Db.organizationMembers)).toEqual([]);
		expect(mocks.stripe).not.toHaveBeenCalled();
		await expect(
			provisionSsoMembership(User.UserId.make(user.id), identity),
		).rejects.toThrow("not linked");

		await adapter.linkAccount({
			userId: user.id,
			provider: "workos",
			providerAccountId: PROFILE.id,
			type: "oauth",
		});
		await adapter.linkAccount({
			userId: user.id,
			provider: "workos",
			providerAccountId: PROFILE.id,
			type: "oauth",
		});
		await provisionSsoMembership(User.UserId.make(user.id), identity);

		expect(fixture.rows(Db.accounts)).toHaveLength(1);
		expect(fixture.rows(Db.organizationMembers)).toEqual([
			expect.objectContaining({
				userId: user.id,
				organizationId: ORGANIZATION_ID,
				role: "member",
				hasProSeat: false,
			}),
		]);
		expect(mocks.stripe).not.toHaveBeenCalled();
	});

	it("refuses to create a different email from the validated SSO identity", async () => {
		const fixture = makeFixture();
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{ getSsoIdentity: () => IDENTITY },
		);
		if (!adapter.createUser) throw new Error("Missing createUser");
		await expect(
			adapter.createUser({
				email: "victim@other.example",
				emailVerified: null,
			}),
		).rejects.toThrow("does not match");
		expect(fixture.client.insert).not.toHaveBeenCalled();
	});

	it("requires validated context to link a WorkOS account", async () => {
		const fixture = makeFixture();
		const adapter = DrizzleAdapter(fixture.client as unknown as MySql2Database);
		if (!adapter.linkAccount) throw new Error("Missing linkAccount");
		await expect(
			adapter.linkAccount({
				userId: USER_ID,
				provider: "workos",
				providerAccountId: PROFILE.id,
				type: "oauth",
			}),
		).rejects.toThrow("not been verified");
		expect(fixture.client.insert).not.toHaveBeenCalled();
	});

	it("does not link the validated identity to a user with a different stored email", async () => {
		const fixture = makeFixture();
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{ getSsoIdentity: () => IDENTITY },
		);
		if (!adapter.linkAccount) throw new Error("Missing linkAccount");

		await expect(
			adapter.linkAccount({
				userId: OTHER_USER_ID,
				provider: "workos",
				providerAccountId: PROFILE.id,
				type: "oauth",
			}),
		).rejects.toThrow("different user");

		expect(fixture.rows(Db.accounts)).toEqual([]);
	});

	it("does not link a different WorkOS profile after validation", async () => {
		const fixture = makeFixture();
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{ getSsoIdentity: () => IDENTITY },
		);
		if (!adapter.linkAccount) throw new Error("Missing linkAccount");

		await expect(
			adapter.linkAccount({
				userId: USER_ID,
				provider: "workos",
				providerAccountId: "prof_01B",
				type: "oauth",
			}),
		).rejects.toThrow("not been verified");

		expect(fixture.client.transaction).not.toHaveBeenCalled();
		expect(fixture.rows(Db.accounts)).toEqual([]);
	});

	it("refuses a conflicting identity link hidden behind duplicate rows after validation", async () => {
		const fixture = makeFixture();
		const identity = await validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT);
		fixture.link();
		fixture.link();
		fixture.link(OTHER_USER_ID);
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{ getSsoIdentity: () => identity },
		);
		if (!adapter.linkAccount) throw new Error("Missing linkAccount");

		await expect(
			adapter.linkAccount({
				userId: USER_ID,
				provider: "workos",
				providerAccountId: PROFILE.id,
				type: "oauth",
			}),
		).rejects.toThrow("another account");

		expect(fixture.rows(Db.accounts)).toEqual([
			expect.objectContaining({ userId: USER_ID }),
			expect.objectContaining({ userId: USER_ID }),
			expect.objectContaining({ userId: OTHER_USER_ID }),
		]);
		expect(fixture.rows(Db.organizationMembers)).toEqual([]);
	});

	it("allows duplicate rows for the same identity through validation, linking, and repeat login", async () => {
		const fixture = makeFixture();
		fixture.link();
		fixture.link();
		const identity = await validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT);
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{ getSsoIdentity: () => identity },
		);
		if (!adapter.linkAccount) throw new Error("Missing linkAccount");

		await adapter.linkAccount({
			userId: USER_ID,
			provider: "workos",
			providerAccountId: PROFILE.id,
			type: "oauth",
		});
		await provisionSsoMembership(USER_ID, identity);
		await provisionSsoMembership(USER_ID, identity);

		expect(fixture.rows(Db.accounts)).toEqual([
			expect.objectContaining({ userId: USER_ID }),
			expect.objectContaining({ userId: USER_ID }),
		]);
		expect(fixture.rows(Db.organizationMembers)).toEqual([
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORGANIZATION_ID,
				role: "member",
				hasProSeat: false,
			}),
		]);
	});

	it("reuses an existing corporate user without changing its organizations or billing", async () => {
		const fixture = makeFixture();
		const identity = await validateSsoSignIn(PROFILE, PROFILE.id, CONTEXT);
		const adapter = DrizzleAdapter(
			fixture.client as unknown as MySql2Database,
			{ getSsoIdentity: () => identity },
		);
		if (!adapter.createUser) throw new Error("Missing createUser");

		const user = await adapter.createUser({
			email: PROFILE.email,
			name: "Alex",
			emailVerified: null,
		});

		expect(user.id).toBe(USER_ID);
		expect(fixture.rows(Db.users)).toHaveLength(2);
		expect(fixture.rows(Db.organizations)).toHaveLength(2);
		expect(fixture.rows(Db.organizationMembers)).toEqual([]);
		expect(fixture.user).toMatchObject({
			defaultOrgId: OTHER_ORGANIZATION_ID,
			activeOrganizationId: OTHER_ORGANIZATION_ID,
		});
		expect(mocks.stripe).not.toHaveBeenCalled();
	});
});

describe("SSO domain normalization", () => {
	it("normalizes case and IDNs without accepting URLs or email addresses", () => {
		expect(normalizeSsoDomain(" Company.Example ")).toBe("company.example");
		expect(normalizeSsoDomain("münchen.example")).toBe(
			"xn--mnchen-3ya.example",
		);
		expect(normalizeSsoDomain("https://company.example")).toBeNull();
		expect(normalizeSsoDomain("alex@company.example")).toBeNull();
		expect(getSsoEmailDomain("alex@company.example")).toBe("company.example");
	});
});
