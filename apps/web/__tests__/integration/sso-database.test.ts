import { randomUUID } from "node:crypto";
import {
	accounts,
	organizationInvites,
	organizationMembers,
	organizationSso,
	organizations,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";
import {
	provisionSsoMembership,
	type ValidatedSsoIdentity,
} from "../../../../packages/database/auth/sso";

const fixture = vi.hoisted(() => ({
	database: undefined as MySql2Database | undefined,
	stripe: vi.fn(() => {
		throw new Error("Database integration tests must not call Stripe.");
	}),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	STRIPE_AVAILABLE: () => false,
	stripe: fixture.stripe,
}));

const databaseUrl = process.env.CAP_SSO_TEST_DATABASE_URL;

function database() {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
}

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

async function makeOrganization() {
	const ownerId = User.UserId.make(id());
	const organizationId = Organisation.OrganisationId.make(id());
	const workosOrganizationId = `org_fixture_${id()}`;
	await database()
		.insert(users)
		.values({
			id: ownerId,
			email: `${ownerId}@example.com`,
			activeOrganizationId: organizationId,
		});
	await database().insert(organizations).values({
		id: organizationId,
		ownerId,
		name: "SSO database fixture",
		workosOrganizationId,
	});
	await database()
		.insert(organizationSso)
		.values({
			organizationId,
			purchasedByUserId: ownerId,
			stripeCustomerId: `cus_fixture_${id()}`,
			stripeSubscriptionId: `sub_fixture_${id()}`,
			status: "active",
			paidThrough: new Date(Date.now() + 86_400_000),
		});
	return { ownerId, organizationId, workosOrganizationId };
}

async function createIdentity() {
	const organization = await makeOrganization();
	const identity: ValidatedSsoIdentity = {
		organizationId: organization.organizationId,
		workosOrganizationId: organization.workosOrganizationId,
		connectionId: `conn_fixture_${id()}`,
		profileId: `prof_fixture_${id()}`,
		email: `${id()}@example.com`,
	};
	const adapter = DrizzleAdapter(database(), {
		getSsoIdentity: () => identity,
	});
	return { identity, adapter, ...organization };
}

async function createUser(
	adapter: Adapter,
	email: string,
): Promise<AdapterUser> {
	if (!adapter.createUser) throw new Error("Missing createUser adapter.");
	return adapter.createUser({
		id: "ignored",
		email,
		name: "SSO teammate",
		emailVerified: null,
	});
}

async function linkAccount(
	adapter: Adapter,
	userId: string,
	profileId: string,
) {
	if (!adapter.linkAccount) throw new Error("Missing linkAccount adapter.");
	await adapter.linkAccount({
		userId,
		type: "oauth",
		provider: "workos",
		providerAccountId: profileId,
		access_token: "fixture-token-must-not-be-persisted",
	});
}

describe.runIf(Boolean(databaseUrl))(
	"SSO with an isolated MySQL database",
	() => {
		let pool: Pool | undefined;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_sso_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error("SSO tests require a session-scoped local database.");
			}
			pool = createPool(databaseUrl);
			fixture.database = drizzle(pool);
			await database().select().from(organizationSso).limit(1);
		});

		afterAll(async () => {
			await pool?.end();
			fixture.database = undefined;
		});

		it("serializes concurrent signups and account links without a personal organization", async () => {
			const { identity, adapter } = await createIdentity();
			const created = await Promise.all(
				Array.from({ length: 6 }, () => createUser(adapter, identity.email)),
			);
			expect(new Set(created.map((user) => user.id)).size).toBe(1);
			const first = created[0];
			if (!first) throw new Error("User was not created.");
			await Promise.all(
				created.map((user) =>
					linkAccount(adapter, user.id, identity.profileId),
				),
			);
			const linked = await database()
				.select()
				.from(accounts)
				.where(eq(accounts.providerAccountId, identity.profileId));
			expect(linked).toHaveLength(1);
			expect(linked[0]?.access_token).toBeNull();
			expect(
				await database()
					.select()
					.from(organizations)
					.where(eq(organizations.ownerId, User.UserId.make(first.id))),
			).toHaveLength(0);
			expect(fixture.stripe).not.toHaveBeenCalled();
		});

		it("accepts duplicate legacy rows but rejects a hidden conflicting account binding", async () => {
			const { identity, adapter, ownerId } = await createIdentity();
			const user = await createUser(adapter, identity.email);
			const userId = User.UserId.make(user.id);
			await database()
				.insert(accounts)
				.values(
					Array.from({ length: 2 }, () => ({
						id: id(),
						userId,
						type: "oauth",
						provider: "workos",
						providerAccountId: identity.profileId,
					})),
				);
			await linkAccount(adapter, userId, identity.profileId);
			await provisionSsoMembership(userId, identity);
			await database().insert(accounts).values({
				id: id(),
				userId: ownerId,
				type: "oauth",
				provider: "workos",
				providerAccountId: identity.profileId,
			});
			await expect(
				linkAccount(adapter, userId, identity.profileId),
			).rejects.toThrow("already linked");
			await expect(provisionSsoMembership(userId, identity)).rejects.toThrow(
				"not linked",
			);
			expect(
				await database()
					.select()
					.from(accounts)
					.where(eq(accounts.providerAccountId, identity.profileId)),
			).toHaveLength(3);
			expect(
				await database()
					.select()
					.from(organizationMembers)
					.where(
						and(
							eq(organizationMembers.userId, userId),
							eq(organizationMembers.organizationId, identity.organizationId),
						),
					),
			).toHaveLength(1);
		});

		it("makes concurrent repeat logins idempotent and accepts only this organization's invitation", async () => {
			const { identity, adapter, ownerId } = await createIdentity();
			const other = await makeOrganization();
			const user = await createUser(adapter, identity.email);
			const userId = User.UserId.make(user.id);
			await linkAccount(adapter, userId, identity.profileId);
			await database()
				.insert(organizationInvites)
				.values([
					{
						id: id(),
						organizationId: identity.organizationId,
						invitedByUserId: ownerId,
						invitedEmail: identity.email,
						role: "member",
					},
					{
						id: id(),
						organizationId: other.organizationId,
						invitedByUserId: other.ownerId,
						invitedEmail: identity.email,
						role: "member",
					},
				]);
			await Promise.all(
				Array.from({ length: 6 }, () =>
					provisionSsoMembership(userId, identity),
				),
			);
			const members = await database()
				.select()
				.from(organizationMembers)
				.where(eq(organizationMembers.userId, userId));
			expect(members).toHaveLength(1);
			expect(members[0]).toMatchObject({
				organizationId: identity.organizationId,
				role: "member",
				hasProSeat: false,
			});
			const invitations = await database()
				.select()
				.from(organizationInvites)
				.where(eq(organizationInvites.invitedEmail, identity.email));
			expect(
				invitations.find(
					(invite) => invite.organizationId === identity.organizationId,
				)?.status,
			).toBe("accepted");
			expect(
				invitations.find(
					(invite) => invite.organizationId === other.organizationId,
				)?.status,
			).toBe("pending");
			const [updatedUser] = await database()
				.select()
				.from(users)
				.where(eq(users.id, userId));
			expect(updatedUser).toMatchObject({
				activeOrganizationId: identity.organizationId,
				defaultOrgId: identity.organizationId,
				stripeCustomerId: null,
				stripeSubscriptionId: null,
			});
			expect(updatedUser?.onboarding_completed_at).toBeInstanceOf(Date);
		});

		it("preserves an existing admin's role, seat and default organization", async () => {
			const { identity, adapter } = await createIdentity();
			const other = await makeOrganization();
			const user = await createUser(adapter, identity.email);
			const userId = User.UserId.make(user.id);
			await linkAccount(adapter, userId, identity.profileId);
			await database().insert(organizationMembers).values({
				id: id(),
				organizationId: identity.organizationId,
				userId,
				role: "admin",
				hasProSeat: true,
			});
			await database()
				.update(users)
				.set({ defaultOrgId: other.organizationId })
				.where(eq(users.id, userId));
			await provisionSsoMembership(userId, identity);
			const [member] = await database()
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, userId),
						eq(organizationMembers.organizationId, identity.organizationId),
					),
				);
			const [updatedUser] = await database()
				.select()
				.from(users)
				.where(eq(users.id, userId));
			expect(member).toMatchObject({ role: "admin", hasProSeat: true });
			expect(updatedUser?.defaultOrgId).toBe(other.organizationId);
		});

		it("rejects a revoked entitlement without partially granting membership", async () => {
			const { identity, adapter } = await createIdentity();
			const user = await createUser(adapter, identity.email);
			const userId = User.UserId.make(user.id);
			await linkAccount(adapter, userId, identity.profileId);
			await database()
				.update(organizationSso)
				.set({ status: "canceled" })
				.where(eq(organizationSso.organizationId, identity.organizationId));
			await expect(provisionSsoMembership(userId, identity)).rejects.toThrow(
				"no longer available",
			);
			expect(
				await database()
					.select()
					.from(organizationMembers)
					.where(eq(organizationMembers.userId, userId)),
			).toHaveLength(0);
		});
	},
);
