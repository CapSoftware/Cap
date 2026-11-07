import { randomUUID } from "node:crypto";
import {
	accounts,
	authApiKeys,
	directoryUsers,
	mcpOAuthTokens,
	organizationDirectorySync,
	organizationInvites,
	organizationMembers,
	organizationSso,
	organizations,
	sessions,
	users,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, ne } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ValidatedSsoIdentity } from "../../../../packages/database/auth/sso";

type FakeUser = {
	id: string;
	directoryId: string;
	email: string;
	firstName: string | null;
	lastName: string | null;
	state: "active" | "inactive";
};

const fixture = vi.hoisted(() => ({
	database: undefined as MySql2Database | undefined,
	organizations: new Map<
		string,
		{ domains: { domain: string; state: string }[] }
	>(),
	directories: new Map<
		string,
		{ id: string; organizationId: string; state: string; name: string }[]
	>(),
	users: new Map<string, FakeUser[]>(),
	pageSize: 2,
	listUserCalls: 0,
	onListUsers: undefined as (() => Promise<void>) | undefined,
	scimDenied: new Set<string>(),
}));

function page<T>(items: T[], after: string | undefined) {
	const start = after ? Number(after) : 0;
	const end = start + fixture.pageSize;
	return {
		data: items.slice(start, end),
		listMetadata: { after: end < items.length ? String(end) : null },
	};
}

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/database/auth/sso", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/auth/sso")>()),
	getWorkOS: () => ({
		organizations: {
			getOrganization: async (organizationId: string) => ({
				id: organizationId,
				domains: fixture.organizations.get(organizationId)?.domains ?? [],
			}),
		},
		directorySync: {
			listDirectories: async (options: {
				organizationId: string;
				after?: string;
			}) =>
				page(
					fixture.directories.get(options.organizationId) ?? [],
					options.after,
				),
			listUsers: async (options: { directory: string; after?: string }) => {
				fixture.listUserCalls++;
				const hook = fixture.onListUsers;
				fixture.onListUsers = undefined;
				await hook?.();
				return page(
					(fixture.users.get(options.directory) ?? []).map((user) => ({
						...user,
						emails: [],
					})),
					options.after,
				);
			},
		},
	}),
}));
vi.mock("@/lib/sso/scim-billing", () => ({
	hasScimSubscription: async (organizationId: string) =>
		!fixture.scimDenied.has(organizationId),
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	STRIPE_AVAILABLE: () => false,
	stripe: () => {
		throw new Error("Database integration tests must not call Stripe.");
	},
}));

const { provisionSsoMembership } = await import(
	"../../../../packages/database/auth/sso"
);
const { runDueDirectorySyncs, syncOrganizationDirectory } = await import(
	"@/lib/sso/directory-sync"
);

const databaseUrl = process.env.CAP_SSO_TEST_DATABASE_URL;

function database() {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
}

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

const later = () => Date.now() + 240_000;

async function makeOrganization() {
	const ownerId = User.UserId.make(id());
	const organizationId = Organisation.OrganisationId.make(id());
	const workosOrganizationId = `org_fixture_${id()}`;
	const domain = `${id()}.test`;
	const directoryId = `directory_${id()}`;
	await database()
		.insert(users)
		.values({
			id: ownerId,
			email: `owner@${domain}`,
			activeOrganizationId: organizationId,
		});
	await database().insert(organizations).values({
		id: organizationId,
		ownerId,
		name: "Directory fixture",
		workosOrganizationId,
	});
	await database().insert(organizationMembers).values({
		id: id(),
		organizationId,
		userId: ownerId,
		role: "owner",
	});
	await database()
		.insert(organizationSso)
		.values({
			organizationId,
			purchasedByUserId: ownerId,
			status: "active",
			paidThrough: new Date(Date.now() + 86_400_000),
		});
	await database()
		.insert(organizationDirectorySync)
		.values({ organizationId, requestedAt: new Date() });
	fixture.organizations.set(workosOrganizationId, {
		domains: [{ domain, state: "verified" }],
	});
	fixture.directories.set(workosOrganizationId, [
		{
			id: directoryId,
			organizationId: workosOrganizationId,
			state: "active",
			name: "Okta",
		},
	]);
	fixture.users.set(directoryId, []);
	return { ownerId, organizationId, workosOrganizationId, domain, directoryId };
}

function directoryUser(
	directoryId: string,
	email: string,
	state: FakeUser["state"] = "active",
): FakeUser {
	return {
		id: `directory_user_${id()}`,
		directoryId,
		email,
		firstName: email.split("@")[0] ?? null,
		lastName: "Fixture",
		state,
	};
}

async function memberIds(organizationId: Organisation.OrganisationId) {
	const rows = await database()
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(eq(organizationMembers.organizationId, organizationId));
	return new Set(rows.map((row) => row.userId));
}

async function userByEmail(email: string) {
	const [user] = await database()
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	return user;
}

describe.runIf(Boolean(databaseUrl))(
	"directory sync with an actual MySQL database",
	() => {
		let pool: Pool | undefined;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
				!/^\/cap_sso_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error("Refusing to use a non-isolated database.");
			}
			pool = createPool(databaseUrl);
			fixture.database = drizzle(pool);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("provisions verified-domain directory users across pages and is idempotent", async () => {
			const org = await makeOrganization();
			const existing = User.UserId.make(id());
			await database()
				.insert(users)
				.values({
					id: existing,
					email: `bob@${org.domain}`,
					name: "Bob Existing",
					activeOrganizationId: Organisation.OrganisationId.make("other"),
				});
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `alice@${org.domain}`),
				directoryUser(org.directoryId, `BOB@${org.domain}`),
				directoryUser(org.directoryId, "carol@unverified.test"),
				directoryUser(org.directoryId, `dave@${org.domain}`, "inactive"),
				directoryUser(org.directoryId, `erin@${org.domain}`),
			]);

			const first = await syncOrganizationDirectory(
				org.organizationId,
				later(),
			);
			expect(first).toMatchObject({ status: "synced", added: 3, skipped: 1 });

			const alice = await userByEmail(`alice@${org.domain}`);
			expect(alice).toMatchObject({
				name: "alice",
				lastName: "Fixture",
				activeOrganizationId: org.organizationId,
				defaultOrgId: org.organizationId,
				marketingOrigin: "teammate",
			});
			const bob = await userByEmail(`bob@${org.domain}`);
			expect(bob?.id).toBe(existing);
			expect(bob?.name).toBe("Bob Existing");
			expect(bob?.activeOrganizationId).toBe("other");
			expect(await userByEmail("carol@unverified.test")).toBeUndefined();
			expect(await userByEmail(`dave@${org.domain}`)).toBeUndefined();

			const members = await memberIds(org.organizationId);
			expect(members.has(existing)).toBe(true);
			expect(alice && members.has(alice.id)).toBe(true);
			expect(members.size).toBe(4);
			const [membership] = await database()
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, org.organizationId),
						eq(organizationMembers.userId, existing),
					),
				);
			expect(membership).toMatchObject({ role: "member", hasProSeat: false });

			const second = await syncOrganizationDirectory(
				org.organizationId,
				later(),
			);
			expect(second).toMatchObject({ status: "synced", added: 0, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(4);
			const links = await database()
				.select()
				.from(directoryUsers)
				.where(eq(directoryUsers.organizationId, org.organizationId));
			expect(links).toHaveLength(3);
		});

		it("deprovisions directory users, revokes their credentials, and keeps the owner and unmanaged members", async () => {
			const org = await makeOrganization();
			const alice = directoryUser(org.directoryId, `alice@${org.domain}`);
			const bob = directoryUser(org.directoryId, `bob@${org.domain}`);
			const owner = directoryUser(org.directoryId, `owner@${org.domain}`);
			fixture.users.set(org.directoryId, [alice, bob, owner]);
			const manual = User.UserId.make(id());
			await database()
				.insert(users)
				.values({
					id: manual,
					email: `manual@${org.domain}`,
					activeOrganizationId: org.organizationId,
				});
			await database().insert(organizationMembers).values({
				id: id(),
				organizationId: org.organizationId,
				userId: manual,
				role: "member",
			});

			await syncOrganizationDirectory(org.organizationId, later());
			const aliceUser = await userByEmail(`alice@${org.domain}`);
			if (!aliceUser) throw new Error("Alice was not provisioned.");
			await database()
				.insert(sessions)
				.values({
					id: id(),
					sessionToken: id(),
					userId: aliceUser.id,
					expires: new Date(Date.now() + 86_400_000),
				});
			await database().insert(authApiKeys).values({
				id: randomUUID(),
				userId: aliceUser.id,
				source: "desktop",
			});
			await database()
				.insert(mcpOAuthTokens)
				.values({
					id: id(),
					userId: aliceUser.id,
					clientId: "client",
					familyId: id(),
					resource: "https://cap.test/mcp",
					accessHash: randomUUID().replaceAll("-", ""),
					refreshHash: randomUUID().replaceAll("-", ""),
					accessExpiresAt: new Date(Date.now() + 3_600_000),
					refreshExpiresAt: new Date(Date.now() + 86_400_000),
				});

			bob.state = "inactive";
			fixture.users.set(org.directoryId, [bob]);
			const result = await syncOrganizationDirectory(
				org.organizationId,
				later(),
			);
			expect(result).toMatchObject({ status: "synced", removed: 3 });

			const members = await memberIds(org.organizationId);
			expect(members.has(aliceUser.id)).toBe(false);
			expect(members.has(org.ownerId)).toBe(true);
			expect(members.has(manual)).toBe(true);
			const bobUser = await userByEmail(`bob@${org.domain}`);
			expect(bobUser && members.has(bobUser.id)).toBe(false);

			const revoked = await userByEmail(`alice@${org.domain}`);
			expect(revoked?.authSessionVersion).toBe(1);
			expect(
				await database()
					.select()
					.from(sessions)
					.where(eq(sessions.userId, aliceUser.id)),
			).toHaveLength(0);
			expect(
				await database()
					.select()
					.from(authApiKeys)
					.where(eq(authApiKeys.userId, aliceUser.id)),
			).toHaveLength(0);
			const [token] = await database()
				.select()
				.from(mcpOAuthTokens)
				.where(eq(mcpOAuthTokens.userId, aliceUser.id));
			expect(token?.revokedAt).toBeInstanceOf(Date);
			const ownerUser = await userByEmail(`owner@${org.domain}`);
			expect(ownerUser?.authSessionVersion).toBe(0);

			bob.state = "active";
			const restored = await syncOrganizationDirectory(
				org.organizationId,
				later(),
			);
			expect(restored).toMatchObject({ added: 1, removed: 0 });
			expect(
				bobUser && (await memberIds(org.organizationId)).has(bobUser.id),
			).toBe(true);
		});

		it("holds a mass removal until an admin approves it", async () => {
			const org = await makeOrganization();
			const people = Array.from({ length: 12 }, (_, index) =>
				directoryUser(org.directoryId, `person${index}@${org.domain}`),
			);
			fixture.users.set(org.directoryId, people);
			await syncOrganizationDirectory(org.organizationId, later());
			expect((await memberIds(org.organizationId)).size).toBe(13);

			fixture.users.set(org.directoryId, people.slice(0, 1));
			const held = await syncOrganizationDirectory(org.organizationId, later());
			expect(held).toMatchObject({ held: 11, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(13);
			const [state] = await database()
				.select()
				.from(organizationDirectorySync)
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);
			expect(state?.heldRemovals).toBe(11);

			await database()
				.update(organizationDirectorySync)
				.set({ removalsApprovedAt: new Date() })
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);
			const applied = await syncOrganizationDirectory(
				org.organizationId,
				later(),
			);
			expect(applied).toMatchObject({ held: 0, removed: 11 });
			expect((await memberIds(org.organizationId)).size).toBe(2);
			const [cleared] = await database()
				.select()
				.from(organizationDirectorySync)
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);
			expect(cleared?.heldRemovals).toBe(0);
			expect(cleared?.removalsApprovedAt).toBeNull();
		});

		it("counts only members who would leave toward a held removal", async () => {
			const org = await makeOrganization();
			const second = `directory_${id()}`;
			fixture.directories.set(org.workosOrganizationId, [
				{
					id: org.directoryId,
					organizationId: org.workosOrganizationId,
					state: "active",
					name: "Okta",
				},
				{
					id: second,
					organizationId: org.workosOrganizationId,
					state: "active",
					name: "Entra ID",
				},
			]);
			const emails = Array.from(
				{ length: 12 },
				(_, index) => `shared${index}@${org.domain}`,
			);
			fixture.users.set(
				org.directoryId,
				emails.map((email) => directoryUser(org.directoryId, email)),
			);
			fixture.users.set(
				second,
				emails.map((email) => directoryUser(second, email)),
			);
			await syncOrganizationDirectory(org.organizationId, later());
			expect((await memberIds(org.organizationId)).size).toBe(13);

			fixture.users.set(org.directoryId, []);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 0, removed: 12 });
			expect((await memberIds(org.organizationId)).size).toBe(13);

			fixture.users.set(second, []);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 12, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(13);
		});

		it("does nothing for an organization without the SCIM add-on", async () => {
			const org = await makeOrganization();
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `alice@${org.domain}`),
			]);
			await syncOrganizationDirectory(org.organizationId, later());
			expect((await memberIds(org.organizationId)).size).toBe(2);

			fixture.scimDenied.add(org.organizationId);
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `bob@${org.domain}`),
			]);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ status: "inactive", added: 0, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(2);
			expect(await userByEmail(`bob@${org.domain}`)).toBeUndefined();
			fixture.scimDenied.delete(org.organizationId);
		});

		it("never removes anyone when the directory disconnects or SSO billing lapses", async () => {
			const org = await makeOrganization();
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `alice@${org.domain}`),
			]);
			await syncOrganizationDirectory(org.organizationId, later());
			expect((await memberIds(org.organizationId)).size).toBe(2);

			fixture.users.set(org.directoryId, []);
			fixture.directories.set(org.workosOrganizationId, [
				{
					id: org.directoryId,
					organizationId: org.workosOrganizationId,
					state: "inactive",
					name: "Okta",
				},
			]);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ status: "no_directory", removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(2);

			fixture.directories.set(org.workosOrganizationId, [
				{
					id: org.directoryId,
					organizationId: org.workosOrganizationId,
					state: "active",
					name: "Okta",
				},
			]);
			await database()
				.update(organizationSso)
				.set({ status: "canceled" })
				.where(eq(organizationSso.organizationId, org.organizationId));
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ status: "inactive", removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(2);
		});

		it("removes a member whose only other link is in a deleted directory", async () => {
			const org = await makeOrganization();
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `alice@${org.domain}`),
			]);
			await syncOrganizationDirectory(org.organizationId, later());
			const alice = await userByEmail(`alice@${org.domain}`);
			if (!alice) throw new Error("Alice was not provisioned.");

			const replacement = `directory_${id()}`;
			fixture.directories.set(org.workosOrganizationId, [
				{
					id: replacement,
					organizationId: org.workosOrganizationId,
					state: "active",
					name: "Entra ID",
				},
			]);
			fixture.users.set(replacement, [
				directoryUser(replacement, `alice@${org.domain}`),
			]);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ added: 1, removed: 0 });
			expect((await memberIds(org.organizationId)).has(alice.id)).toBe(true);

			fixture.users.set(replacement, []);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ removed: 1 });
			expect((await memberIds(org.organizationId)).has(alice.id)).toBe(false);
		});

		it("lets only one sync hold the lease and picks up due organizations", async () => {
			const org = await makeOrganization();
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `alice@${org.domain}`),
				directoryUser(org.directoryId, `bob@${org.domain}`),
				directoryUser(org.directoryId, `carol@${org.domain}`),
			]);
			const results = await Promise.all([
				syncOrganizationDirectory(org.organizationId, later()),
				syncOrganizationDirectory(org.organizationId, later()),
			]);
			expect(results.map((result) => result.status).sort()).toEqual([
				"busy",
				"synced",
			]);
			expect((await memberIds(org.organizationId)).size).toBe(4);

			const due = await makeOrganization();
			fixture.users.set(due.directoryId, [
				directoryUser(due.directoryId, `alice@${due.domain}`),
			]);
			await database()
				.update(organizationDirectorySync)
				.set({
					syncedAt: new Date(),
					requestedAt: new Date(Date.now() - 60_000),
				})
				.where(
					ne(organizationDirectorySync.organizationId, due.organizationId),
				);
			const summary = await runDueDirectorySyncs(later());
			expect(summary.failed).toBe(0);
			expect((await memberIds(due.organizationId)).size).toBe(2);
			const [state] = await database()
				.select()
				.from(organizationDirectorySync)
				.where(
					eq(organizationDirectorySync.organizationId, due.organizationId),
				);
			expect(state?.syncedAt).toBeInstanceOf(Date);
			expect(state?.leaseExpiresAt).toBeNull();
		});

		it("backs off only when a full sync budget cannot read the directory", async () => {
			const slowRead = async (budget: number) => {
				const org = await makeOrganization();
				fixture.users.set(
					org.directoryId,
					["alice", "bob", "carol"].map((name) =>
						directoryUser(org.directoryId, `${name}@${org.domain}`),
					),
				);
				const realNow = Date.now;
				const start = realNow();
				const calls = fixture.listUserCalls;
				const clock = vi
					.spyOn(Date, "now")
					.mockImplementation(() =>
						fixture.listUserCalls > calls ? start + budget + 1 : realNow(),
					);
				let outcome: unknown;
				try {
					outcome = await syncOrganizationDirectory(
						org.organizationId,
						start + budget,
					).catch((error: Error) => error);
				} finally {
					clock.mockRestore();
				}
				const [state] = await database()
					.select()
					.from(organizationDirectorySync)
					.where(
						eq(organizationDirectorySync.organizationId, org.organizationId),
					);
				return { org, outcome, state };
			};

			const full = await slowRead(240_000);
			expect(full.outcome).toBeInstanceOf(Error);
			expect(full.state?.lastError).toContain("could not be read");
			expect(full.state?.leaseExpiresAt?.getTime()).toBeGreaterThan(
				Date.now() + 30 * 60_000,
			);
			expect((await memberIds(full.org.organizationId)).size).toBe(1);

			const late = await slowRead(30_000);
			expect(late.outcome).toMatchObject({ status: "partial" });
			expect(late.state?.lastError).toBeNull();
			expect(late.state?.leaseExpiresAt).toBeNull();
			expect(
				await syncOrganizationDirectory(late.org.organizationId, later()),
			).toMatchObject({ status: "synced", added: 3 });
		});

		it("resumes provisioning when the deadline passes after the directory is read", async () => {
			const org = await makeOrganization();
			fixture.users.set(org.directoryId, [
				directoryUser(org.directoryId, `alice@${org.domain}`),
				directoryUser(org.directoryId, `bob@${org.domain}`),
			]);
			const realNow = Date.now;
			const deadline = realNow() + 60_000;
			const calls = fixture.listUserCalls;
			const clock = vi
				.spyOn(Date, "now")
				.mockImplementation(() =>
					fixture.listUserCalls > calls ? realNow() + 120_000 : realNow(),
				);
			try {
				expect(
					await syncOrganizationDirectory(org.organizationId, deadline),
				).toMatchObject({ status: "partial" });
			} finally {
				clock.mockRestore();
			}
			const [state] = await database()
				.select()
				.from(organizationDirectorySync)
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);
			expect(state?.syncedAt).toBeNull();
			expect(state?.leaseExpiresAt).toBeNull();
			expect(state?.requestedAt).toBeInstanceOf(Date);
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ status: "synced", added: 2 });
			expect((await memberIds(org.organizationId)).size).toBe(3);
		});

		it("keeps a member an admin removed in Cap out until they are invited again", async () => {
			const org = await makeOrganization();
			const alice = directoryUser(org.directoryId, `alice@${org.domain}`);
			fixture.users.set(org.directoryId, [alice]);
			await syncOrganizationDirectory(org.organizationId, later());
			const aliceUser = await userByEmail(`alice@${org.domain}`);
			if (!aliceUser) throw new Error("Alice was not provisioned.");
			await database()
				.delete(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, org.organizationId),
						eq(organizationMembers.userId, aliceUser.id),
					),
				);

			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ added: 0, removed: 0 });
			expect((await memberIds(org.organizationId)).has(aliceUser.id)).toBe(
				false,
			);

			const sessionVersion = (await userByEmail(`alice@${org.domain}`))
				?.authSessionVersion;
			fixture.users.set(org.directoryId, []);
			await syncOrganizationDirectory(org.organizationId, later());
			expect(
				(await userByEmail(`alice@${org.domain}`))?.authSessionVersion,
			).toBe(sessionVersion);
			fixture.users.set(org.directoryId, [alice]);

			const profileId = `prof_fixture_${id()}`;
			await database().insert(accounts).values({
				id: id(),
				userId: aliceUser.id,
				type: "oauth",
				provider: "workos",
				providerAccountId: profileId,
			});
			const identity: ValidatedSsoIdentity = {
				organizationId: org.organizationId,
				workosOrganizationId: org.workosOrganizationId,
				connectionId: `conn_fixture_${id()}`,
				profileId,
				email: `alice@${org.domain}`,
			};
			await expect(
				provisionSsoMembership(aliceUser.id, identity),
			).rejects.toThrow("no longer have access");

			await database()
				.insert(organizationInvites)
				.values({
					id: id(),
					organizationId: org.organizationId,
					invitedEmail: `alice@${org.domain}`,
					invitedByUserId: org.ownerId,
					role: "member",
				});
			await provisionSsoMembership(aliceUser.id, identity);
			expect((await memberIds(org.organizationId)).has(aliceUser.id)).toBe(
				true,
			);
		});

		it("only applies an approval up to the number of removals confirmed", async () => {
			const org = await makeOrganization();
			const people = Array.from({ length: 30 }, (_, index) =>
				directoryUser(org.directoryId, `bulk${index}@${org.domain}`),
			);
			fixture.users.set(org.directoryId, people);
			await syncOrganizationDirectory(org.organizationId, later());
			expect((await memberIds(org.organizationId)).size).toBe(31);

			fixture.users.set(org.directoryId, people.slice(12));
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 12, removed: 0 });
			await database()
				.update(organizationDirectorySync)
				.set({ removalsApprovedAt: new Date(), heldRemovals: 12 })
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);

			fixture.users.set(org.directoryId, people.slice(25));
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 25, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(31);
			const [afterLargerHold] = await database()
				.select()
				.from(organizationDirectorySync)
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);
			expect(afterLargerHold?.removalsApprovedAt).toBeNull();
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 25, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(31);
		});

		it("keeps the confirmed count when an approval lands during a running sync", async () => {
			const org = await makeOrganization();
			const people = Array.from({ length: 30 }, (_, index) =>
				directoryUser(org.directoryId, `race${index}@${org.domain}`),
			);
			fixture.users.set(org.directoryId, people);
			await syncOrganizationDirectory(org.organizationId, later());
			fixture.users.set(org.directoryId, people.slice(12));
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 12 });

			fixture.users.set(org.directoryId, people.slice(25));
			fixture.onListUsers = async () => {
				await database()
					.update(organizationDirectorySync)
					.set({ removalsApprovedAt: new Date(), heldRemovals: 12 })
					.where(
						eq(organizationDirectorySync.organizationId, org.organizationId),
					);
			};
			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 25, removed: 0 });
			const [afterRace] = await database()
				.select()
				.from(organizationDirectorySync)
				.where(
					eq(organizationDirectorySync.organizationId, org.organizationId),
				);
			expect(afterRace?.heldRemovals).toBe(12);
			expect(afterRace?.removalsApprovedAt).toBeInstanceOf(Date);

			expect(
				await syncOrganizationDirectory(org.organizationId, later()),
			).toMatchObject({ held: 25, removed: 0 });
			expect((await memberIds(org.organizationId)).size).toBe(31);
		});

		it("keeps SSO from re-adding a member the directory removed", async () => {
			const org = await makeOrganization();
			const alice = directoryUser(org.directoryId, `alice@${org.domain}`);
			fixture.users.set(org.directoryId, [alice]);
			await syncOrganizationDirectory(org.organizationId, later());
			const aliceUser = await userByEmail(`alice@${org.domain}`);
			if (!aliceUser) throw new Error("Alice was not provisioned.");
			const profileId = `prof_fixture_${id()}`;
			await database().insert(accounts).values({
				id: id(),
				userId: aliceUser.id,
				type: "oauth",
				provider: "workos",
				providerAccountId: profileId,
			});
			const identity: ValidatedSsoIdentity = {
				organizationId: org.organizationId,
				workosOrganizationId: org.workosOrganizationId,
				connectionId: `conn_fixture_${id()}`,
				profileId,
				email: `alice@${org.domain}`,
			};

			fixture.users.set(org.directoryId, []);
			await syncOrganizationDirectory(org.organizationId, later());
			expect((await memberIds(org.organizationId)).has(aliceUser.id)).toBe(
				false,
			);
			await expect(
				provisionSsoMembership(aliceUser.id, identity),
			).rejects.toThrow("no longer have access");
			expect((await memberIds(org.organizationId)).has(aliceUser.id)).toBe(
				false,
			);

			await database()
				.insert(organizationInvites)
				.values({
					id: id(),
					organizationId: org.organizationId,
					invitedEmail: `alice@${org.domain}`,
					invitedByUserId: org.ownerId,
					role: "member",
				});
			await provisionSsoMembership(aliceUser.id, identity);
			expect((await memberIds(org.organizationId)).has(aliceUser.id)).toBe(
				true,
			);
			await database()
				.delete(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, org.organizationId),
						eq(organizationMembers.userId, aliceUser.id),
					),
				);

			fixture.users.set(org.directoryId, [alice]);
			await syncOrganizationDirectory(org.organizationId, later());
			await provisionSsoMembership(aliceUser.id, identity);
			expect((await memberIds(org.organizationId)).has(aliceUser.id)).toBe(
				true,
			);

			const outsider = User.UserId.make(id());
			const outsiderProfile = `prof_fixture_${id()}`;
			await database()
				.insert(users)
				.values({
					id: outsider,
					email: `outsider@${org.domain}`,
					activeOrganizationId: org.organizationId,
				});
			await database().insert(accounts).values({
				id: id(),
				userId: outsider,
				type: "oauth",
				provider: "workos",
				providerAccountId: outsiderProfile,
			});
			await provisionSsoMembership(outsider, {
				...identity,
				profileId: outsiderProfile,
				email: `outsider@${org.domain}`,
			});
			expect((await memberIds(org.organizationId)).has(outsider)).toBe(true);
		});
	},
);
