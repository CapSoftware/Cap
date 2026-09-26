import { randomUUID } from "node:crypto";
import {
	directoryAccessAllowed,
	directorySpaceAccessAllowed,
	hasDirectoryAccess,
	requireDirectoryMembership,
} from "@cap/database/directory-sync/access";
import {
	applyDirectoryUser,
	type DirectoryConfiguration,
	type SyncedDirectoryUser,
} from "@cap/database/directory-sync/users";
import { syncClaimedDirectory } from "@cap/database/directory-sync/worker";
import * as Db from "@cap/database/schema";
import { Organisation, Space, User, Video } from "@cap/web-domain";
import type { WorkOS } from "@workos-inc/node";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.CAP_DIRECTORY_SYNC_DATABASE_TESTS === "true";
const newId = () => randomUUID().replaceAll("-", "").slice(0, 15);
const organizationIds: Organisation.OrganisationId[] = [];
const userIds: User.UserId[] = [];
const videoIds: Video.VideoId[] = [];
let pool: Pool;
let database: MySql2Database;

async function fixture() {
	const organizationId = Organisation.OrganisationId.make(newId());
	const ownerId = User.UserId.make(newId());
	organizationIds.push(organizationId);
	userIds.push(ownerId);
	await database.insert(Db.users).values({
		id: ownerId,
		email: `${ownerId}@example.com`,
		activeOrganizationId: organizationId,
	});
	await database.insert(Db.organizations).values({
		id: organizationId,
		ownerId,
		name: "Directory fixture",
		workosOrganizationId: `org_${organizationId}`,
	});
	await database.insert(Db.organizationDirectorySync).values({
		organizationId,
		workosOrganizationId: `org_${organizationId}`,
		directoryId: `directory_${organizationId}`,
		state: "active",
		eventStartedAt: new Date(),
		nextAttemptAt: new Date(),
		leaseToken: "fixture-lease",
		leaseUntil: new Date(Date.now() + 90_000),
	});
	const [configuration] = await database
		.select()
		.from(Db.organizationDirectorySync)
		.where(eq(Db.organizationDirectorySync.organizationId, organizationId));
	if (!configuration) throw new Error("Fixture was not created");
	const remote: SyncedDirectoryUser = {
		id: `directory_user_${newId()}`,
		idpId: newId(),
		directoryId: configuration.directoryId ?? "",
		organizationId: configuration.workosOrganizationId,
		email: `${newId()}@example.com`,
		firstName: "Directory",
		lastName: "Teammate",
		state: "active",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	return { configuration, remote, ownerId };
}

async function apply(
	configuration: DirectoryConfiguration,
	remote: SyncedDirectoryUser,
) {
	await database.transaction(async (tx) => {
		await tx
			.select({ id: Db.organizations.id })
			.from(Db.organizations)
			.where(eq(Db.organizations.id, configuration.organizationId))
			.for("update");
		await applyDirectoryUser(tx, configuration, remote, ["example.com"]);
	});
	const [record] = await database
		.select()
		.from(Db.directoryUsers)
		.where(eq(Db.directoryUsers.directoryUserId, remote.id));
	if (record?.userId && !userIds.includes(record.userId))
		userIds.push(record.userId);
	return record;
}

async function requireRecord(
	configuration: DirectoryConfiguration,
	remote: SyncedDirectoryUser,
) {
	const record = await apply(configuration, remote);
	if (!record?.userId) throw new Error("Directory user was not linked");
	return { ...record, userId: record.userId };
}

async function memberships(userId: User.UserId) {
	return database
		.select()
		.from(Db.organizationMembers)
		.where(eq(Db.organizationMembers.userId, userId));
}

describe.runIf(enabled)(
	"Directory Sync with an isolated development database",
	() => {
		beforeAll(async () => {
			const session = process.env.CAP_BUILDING_SESSION;
			if (
				!session ||
				!process.cwd().includes(`${session}/apps/web`) ||
				!process.env.DATABASE_URL
			)
				throw new Error(
					"Directory tests require the owned building session environment",
				);
			pool = createPool(process.env.DATABASE_URL);
			database = drizzle(pool);
			await database.select().from(Db.directoryUsers).limit(1);
		});

		afterAll(async () => {
			if (!database) return;
			if (videoIds.length)
				await database.delete(Db.videos).where(inArray(Db.videos.id, videoIds));
			if (organizationIds.length) {
				const identities = await database
					.select({ userId: Db.directoryUsers.userId })
					.from(Db.directoryUsers)
					.where(inArray(Db.directoryUsers.organizationId, organizationIds));
				for (const identity of identities)
					if (identity.userId && !userIds.includes(identity.userId))
						userIds.push(identity.userId);
				const spaces = await database
					.select({ id: Db.spaces.id })
					.from(Db.spaces)
					.where(inArray(Db.spaces.organizationId, organizationIds));
				if (spaces.length)
					await database.delete(Db.spaceMembers).where(
						inArray(
							Db.spaceMembers.spaceId,
							spaces.map((space) => space.id),
						),
					);
				await database
					.delete(Db.spaces)
					.where(inArray(Db.spaces.organizationId, organizationIds));
				await database
					.delete(Db.directoryUsers)
					.where(inArray(Db.directoryUsers.organizationId, organizationIds));
				await database
					.delete(Db.organizationDirectorySync)
					.where(
						inArray(
							Db.organizationDirectorySync.organizationId,
							organizationIds,
						),
					);
				await database
					.delete(Db.organizationInvites)
					.where(
						inArray(Db.organizationInvites.organizationId, organizationIds),
					);
				await database
					.delete(Db.organizationMembers)
					.where(
						inArray(Db.organizationMembers.organizationId, organizationIds),
					);
				await database
					.delete(Db.organizations)
					.where(inArray(Db.organizations.id, organizationIds));
			}
			if (userIds.length)
				await database
					.delete(Db.loopsSyncJobs)
					.where(inArray(Db.loopsSyncJobs.userId, userIds));
			if (userIds.length)
				await database.delete(Db.users).where(inArray(Db.users.id, userIds));
			await pool.end();
		});

		it("provisions one account before login without personal organizations, billing, or email verification", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			const [user] = await database
				.select()
				.from(Db.users)
				.where(eq(Db.users.id, record.userId));
			expect(user).toMatchObject({
				email: remote.email,
				name: "Directory",
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				emailVerified: null,
			});
			expect(await memberships(record.userId)).toEqual([
				expect.objectContaining({
					role: "member",
					hasProSeat: false,
					organizationId: configuration.organizationId,
				}),
			]);
			expect(
				await database
					.select()
					.from(Db.organizations)
					.where(eq(Db.organizations.ownerId, record.userId)),
			).toHaveLength(0);
		});

		it("preserves existing administrator roles, seats, subscriptions, and organization selection", async () => {
			const { configuration, remote } = await fixture();
			const other = await fixture();
			const userId = User.UserId.make(newId());
			userIds.push(userId);
			await database.insert(Db.users).values({
				id: userId,
				email: remote.email ?? "",
				stripeCustomerId: "cus_fixture",
				stripeSubscriptionId: "sub_fixture",
				activeOrganizationId: other.configuration.organizationId,
				defaultOrgId: other.configuration.organizationId,
			});
			await database.insert(Db.organizationMembers).values({
				id: newId(),
				userId,
				organizationId: configuration.organizationId,
				role: "admin",
				hasProSeat: true,
			});
			expect((await requireRecord(configuration, remote)).userId).toBe(userId);
			expect(await memberships(userId)).toEqual([
				expect.objectContaining({ role: "admin", hasProSeat: true }),
			]);
			const [user] = await database
				.select()
				.from(Db.users)
				.where(eq(Db.users.id, userId));
			expect(user).toMatchObject({
				stripeCustomerId: "cus_fixture",
				stripeSubscriptionId: "sub_fixture",
				activeOrganizationId: other.configuration.organizationId,
				defaultOrgId: other.configuration.organizationId,
			});
		});

		it("revokes organization, creator and space access without deleting recordings or unrelated memberships", async () => {
			const { configuration, remote, ownerId } = await fixture();
			const record = await requireRecord(configuration, remote);
			const other = await fixture();
			await database.insert(Db.organizationMembers).values({
				id: newId(),
				userId: record.userId,
				organizationId: other.configuration.organizationId,
				role: "member",
				hasProSeat: true,
			});
			const spaceId = Space.SpaceId.make(newId());
			await database.insert(Db.spaces).values({
				id: spaceId,
				name: "Fixture space",
				createdById: record.userId,
				organizationId: configuration.organizationId,
			});
			await database
				.insert(Db.spaceMembers)
				.values({ id: newId(), userId: record.userId, spaceId, role: "admin" });
			await database.insert(Db.organizationInvites).values({
				id: newId(),
				organizationId: configuration.organizationId,
				invitedEmail: remote.email ?? "",
				invitedByUserId: ownerId,
				role: "member",
			});
			const videoId = Video.VideoId.make(newId());
			videoIds.push(videoId);
			await database.insert(Db.videos).values({
				id: videoId,
				name: "Preserved recording",
				ownerId: record.userId,
				orgId: configuration.organizationId,
				public: false,
			});
			await apply(configuration, {
				...remote,
				state: "inactive",
				updatedAt: "2026-01-02T00:00:00.000Z",
			});
			expect(await memberships(record.userId)).toEqual([
				expect.objectContaining({
					organizationId: other.configuration.organizationId,
					hasProSeat: true,
				}),
			]);
			expect(
				await hasDirectoryAccess(
					record.userId,
					configuration.organizationId,
					database,
				),
			).toBe(false);
			expect(
				await hasDirectoryAccess(
					record.userId,
					other.configuration.organizationId,
					database,
				),
			).toBe(true);
			expect(
				await database
					.select()
					.from(Db.spaceMembers)
					.where(eq(Db.spaceMembers.spaceId, spaceId)),
			).toHaveLength(0);
			expect(
				await database
					.select()
					.from(Db.organizationInvites)
					.where(
						eq(
							Db.organizationInvites.organizationId,
							configuration.organizationId,
						),
					),
			).toHaveLength(0);
			expect(
				await database
					.select()
					.from(Db.videos)
					.where(eq(Db.videos.id, videoId)),
			).toHaveLength(1);
			expect(
				await database
					.select()
					.from(Db.videos)
					.where(
						and(
							eq(Db.videos.id, videoId),
							directoryAccessAllowed(record.userId, Db.videos.orgId),
						),
					),
			).toHaveLength(0);
			expect(
				await database
					.select()
					.from(Db.spaces)
					.where(
						and(
							eq(Db.spaces.id, spaceId),
							directorySpaceAccessAllowed(record.userId, Db.spaces.id),
						),
					),
			).toHaveLength(0);
			const allowedSpaceId = Space.SpaceId.make(newId());
			await database.insert(Db.spaces).values({
				id: allowedSpaceId,
				name: "Other space",
				createdById: record.userId,
				organizationId: other.configuration.organizationId,
			});
			expect(
				await database
					.select()
					.from(Db.spaces)
					.where(
						and(
							eq(Db.spaces.id, allowedSpaceId),
							directorySpaceAccessAllowed(record.userId, Db.spaces.id),
						),
					),
			).toHaveLength(1);
			const [user] = await database
				.select()
				.from(Db.users)
				.where(eq(Db.users.id, record.userId));
			expect(user?.activeOrganizationId).toBe(
				other.configuration.organizationId,
			);
			await expect(
				requireDirectoryMembership(
					database,
					configuration.organizationId,
					remote.email ?? "",
					record.userId,
				),
			).rejects.toThrow("assign you");
		});

		it("does not recreate membership from an older event and restores the same account on reactivation", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			await apply(configuration, {
				...remote,
				state: "inactive",
				updatedAt: "2026-01-03T00:00:00.000Z",
			});
			await apply(configuration, remote);
			expect(await memberships(record.userId)).toHaveLength(0);
			const reactivated = await apply(configuration, {
				...remote,
				id: `directory_user_${newId()}`,
				updatedAt: "2026-01-04T00:00:00.000Z",
			});
			expect(reactivated?.userId).toBe(record.userId);
			expect(await memberships(record.userId)).toEqual([
				expect.objectContaining({ role: "member", hasProSeat: false }),
			]);
		});

		it("serializes concurrent deliveries without duplicate accounts or memberships", async () => {
			const { configuration, remote } = await fixture();
			const records = await Promise.all(
				Array.from({ length: 4 }, () => apply(configuration, remote)),
			);
			const record = records[0];
			if (!record?.userId) throw new Error("Missing account");
			expect(new Set(records.map((entry) => entry?.userId)).size).toBe(1);
			expect(await memberships(record.userId)).toHaveLength(1);
		});

		it("rejects wrong tenants and identity reassignment", async () => {
			const { configuration, remote } = await fixture();
			await expect(
				apply(configuration, { ...remote, organizationId: "org_wrong" }),
			).rejects.toThrow("mismatch");
			await requireRecord(configuration, remote);
			await expect(
				apply(configuration, { ...remote, idpId: "different_person" }),
			).rejects.toThrow("conflict");
		});

		it("holds email changes for review instead of merging or rewriting an existing account", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			const changed = await apply(configuration, {
				...remote,
				email: `${newId()}@example.com`,
				updatedAt: "2026-01-02T00:00:00.000Z",
			});
			expect(changed).toMatchObject({
				userId: record.userId,
				state: "conflict",
				lastError: "email_change_requires_review",
			});
			const [user] = await database
				.select()
				.from(Db.users)
				.where(eq(Db.users.id, record.userId));
			expect(user?.email).toBe(remote.email);
			expect(await memberships(record.userId)).toHaveLength(0);
		});

		it.each([null, "someone@unverified.example"])(
			"does not provision an untrusted email %s",
			async (email) => {
				const { configuration, remote } = await fixture();
				const record = await apply(configuration, { ...remote, email });
				expect(record).toMatchObject({ userId: null, state: "conflict" });
			},
		);

		it("deprovisions an existing account when deletion arrives before initial synchronization", async () => {
			const { configuration, remote } = await fixture();
			const userId = User.UserId.make(newId());
			userIds.push(userId);
			await database.insert(Db.users).values({
				id: userId,
				email: remote.email ?? "",
				activeOrganizationId: configuration.organizationId,
			});
			await database.insert(Db.organizationMembers).values({
				id: newId(),
				userId,
				organizationId: configuration.organizationId,
				role: "member",
			});
			await apply(configuration, { ...remote, state: "inactive" });
			expect(await memberships(userId)).toHaveLength(0);
			expect(
				await hasDirectoryAccess(
					userId,
					configuration.organizationId,
					database,
				),
			).toBe(false);
		});

		it("denies a directory-managed owner even when ownership remains in the organization record", async () => {
			const { configuration, remote, ownerId } = await fixture();
			const ownerRemote = { ...remote, email: `${ownerId}@example.com` };
			await requireRecord(configuration, ownerRemote);
			await apply(configuration, {
				...ownerRemote,
				state: "inactive",
				updatedAt: "2026-01-02T00:00:00.000Z",
			});
			expect(
				await database
					.select()
					.from(Db.organizations)
					.where(
						and(
							eq(Db.organizations.ownerId, ownerId),
							directoryAccessAllowed(ownerId, Db.organizations.id),
						),
					),
			).toHaveLength(0);
		});

		it("handles whole-directory deletion without depending on individual deletion events", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			const workos = {
				directorySync: {
					getDirectory: async () => {
						throw Object.assign(new Error("Not found"), { status: 404 });
					},
				},
			} as unknown as WorkOS;
			await syncClaimedDirectory(
				database,
				workos,
				configuration,
				Date.now() + 15_000,
			);
			expect(await memberships(record.userId)).toHaveLength(0);
			expect(
				await hasDirectoryAccess(
					record.userId,
					configuration.organizationId,
					database,
				),
			).toBe(false);
		});

		it("fences an expired worker before it can mutate membership", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			await database
				.update(Db.organizationDirectorySync)
				.set({ leaseToken: "new-owner" })
				.where(
					eq(
						Db.organizationDirectorySync.organizationId,
						configuration.organizationId,
					),
				);
			const workos = {
				directorySync: {
					getDirectory: async () => {
						throw Object.assign(new Error("Not found"), { status: 404 });
					},
				},
			} as unknown as WorkOS;
			await expect(
				syncClaimedDirectory(
					database,
					workos,
					configuration,
					Date.now() + 15_000,
				),
			).rejects.toThrow("lease_lost");
			expect(await memberships(record.userId)).toHaveLength(1);
		});

		it("leaves organizations without provisioning unchanged", async () => {
			const { configuration, ownerId } = await fixture();
			await database
				.delete(Db.organizationDirectorySync)
				.where(
					eq(
						Db.organizationDirectorySync.organizationId,
						configuration.organizationId,
					),
				);
			await expect(
				requireDirectoryMembership(
					database,
					configuration.organizationId,
					`${ownerId}@example.com`,
					ownerId,
				),
			).resolves.toBeUndefined();
			expect(
				await hasDirectoryAccess(
					ownerId,
					configuration.organizationId,
					database,
				),
			).toBe(true);
		});
		it.each(["2025-12-31T23:59:59.000Z", "2026-01-02T00:00:00.000Z"])(
			"checkpoints deletion at %s without a stale snapshot restoring access",
			async (createdAt) => {
				const { configuration, remote } = await fixture();
				const record = await requireRecord(configuration, remote);
				const eventId = `event_${newId()}`;
				const workos = {
					directorySync: {
						getDirectory: async () => ({
							id: configuration.directoryId,
							organizationId: configuration.workosOrganizationId,
							state: "active",
						}),
						listUsers: async () => ({
							data: [remote],
							listMetadata: { after: null },
						}),
					},
					organizations: {
						getOrganization: async () => ({
							id: configuration.workosOrganizationId,
							domains: [{ domain: "example.com", state: "verified" }],
						}),
					},
					events: {
						listEvents: async () => ({
							data: [
								{
									id: eventId,
									event: "dsync.user.deleted",
									data: remote,
									createdAt,
								},
							],
						}),
					},
				} as unknown as WorkOS;
				await syncClaimedDirectory(
					database,
					workos,
					configuration,
					Date.now() + 25_000,
				);
				expect(await memberships(record.userId)).toHaveLength(0);
				const [updated] = await database
					.select()
					.from(Db.organizationDirectorySync)
					.where(
						eq(
							Db.organizationDirectorySync.organizationId,
							configuration.organizationId,
						),
					);
				expect(updated?.eventCursor).toBe(eventId);
				expect(updated?.lastReconciledAt).toBeInstanceOf(Date);
			},
		);

		it("reconciles missing users after missed events without retiring present users", async () => {
			const { configuration, remote } = await fixture();
			const missing = await requireRecord(configuration, remote);
			const presentRemote = {
				...remote,
				id: `directory_user_${newId()}`,
				idpId: newId(),
				email: `${newId()}@example.com`,
			};
			const present = await requireRecord(configuration, presentRemote);
			const workos = {
				directorySync: {
					getDirectory: async () => ({
						id: configuration.directoryId,
						organizationId: configuration.workosOrganizationId,
						state: "active",
					}),
					listUsers: async () => ({
						data: [presentRemote],
						listMetadata: { after: null },
					}),
					getUser: async () => {
						throw Object.assign(new Error("Not found"), { status: 404 });
					},
				},
				organizations: {
					getOrganization: async () => ({
						id: configuration.workosOrganizationId,
						domains: [{ domain: "example.com", state: "verified" }],
					}),
				},
				events: { listEvents: async () => ({ data: [] }) },
			} as unknown as WorkOS;
			await syncClaimedDirectory(
				database,
				workos,
				configuration,
				Date.now() + 25_000,
			);
			expect(await memberships(missing.userId)).toHaveLength(0);
			expect(await memberships(present.userId)).toHaveLength(1);
			expect(
				await hasDirectoryAccess(
					missing.userId,
					configuration.organizationId,
					database,
				),
			).toBe(false);
		});

		it("resumes a multi-page snapshot after the deadline interrupts a page", async () => {
			const { configuration, remote } = await fixture();
			const missing = await requireRecord(configuration, remote);
			const remotes = Array.from({ length: 5 }, () => ({
				...remote,
				id: `directory_user_${newId()}`,
				idpId: newId(),
				email: `${newId()}@example.com`,
			}));
			const cursors: (string | undefined)[] = [];
			const deadline = Date.now() + 30000;
			let now = Date.now();
			let interrupt = true;
			const workos = {
				directorySync: {
					getDirectory: async () => ({
						id: configuration.directoryId,
						organizationId: configuration.workosOrganizationId,
						state: "active",
					}),
					listUsers: async ({ after }: { after?: string }) => {
						cursors.push(after);
						const offset = after
							? remotes.findIndex((user) => user.id === after) + 1
							: 0;
						const data = remotes.slice(offset, offset + 2);
						if (offset === 2 && interrupt) now = deadline;
						return {
							data,
							listMetadata: {
								after: offset + 2 < remotes.length ? data.at(-1)?.id : null,
							},
						};
					},
					getUser: async () => {
						throw Object.assign(new Error("Not found"), { status: 404 });
					},
				},
				organizations: {
					getOrganization: async () => ({
						id: configuration.workosOrganizationId,
						domains: [{ domain: "example.com", state: "verified" }],
					}),
				},
				events: { listEvents: async () => ({ data: [] }) },
			} as unknown as WorkOS;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			try {
				await syncClaimedDirectory(database, workos, configuration, deadline);
			} finally {
				clock.mockRestore();
			}
			const [saved] = await database
				.select()
				.from(Db.organizationDirectorySync)
				.where(
					eq(
						Db.organizationDirectorySync.organizationId,
						configuration.organizationId,
					),
				);
			if (!saved) throw new Error("Configuration was not persisted");
			expect(saved.reconcileCursor).toBe(remotes[2]?.id);
			expect(saved.reconcileListingComplete).toBe(false);
			expect(saved.lastReconciledAt).toBeNull();
			expect(await memberships(missing.userId)).toHaveLength(1);
			interrupt = false;
			await syncClaimedDirectory(database, workos, saved, Date.now() + 30000);
			expect(cursors).toEqual([undefined, remotes[1]?.id, remotes[2]?.id]);
			const identities = await database
				.select()
				.from(Db.directoryUsers)
				.where(
					eq(Db.directoryUsers.organizationId, configuration.organizationId),
				);
			expect(identities.filter((user) => user.state === "active")).toHaveLength(
				5,
			);
			for (const identity of identities.filter(
				(user) => user.state === "active",
			)) {
				if (!identity.userId) throw new Error("User was not bound");
				expect(await memberships(identity.userId)).toHaveLength(1);
			}
			expect(await memberships(missing.userId)).toHaveLength(0);
		});

		it("queues profile refreshes for signed-up membership changes without enrolling pre-login users", async () => {
			const prior = process.env.LOOPS_SYNC_ENABLED;
			process.env.LOOPS_SYNC_ENABLED = "true";
			try {
				const { configuration, remote, ownerId } = await fixture();
				const fresh = await requireRecord(configuration, remote);
				expect(
					await database
						.select()
						.from(Db.loopsSyncJobs)
						.where(eq(Db.loopsSyncJobs.userId, fresh.userId)),
				).toHaveLength(0);
				await database
					.update(Db.users)
					.set({ emailVerified: new Date() })
					.where(eq(Db.users.id, ownerId));
				const existingRemote = {
					...remote,
					id: `directory_user_${newId()}`,
					idpId: newId(),
					email: `${ownerId}@example.com`,
				};
				await requireRecord(configuration, existingRemote);
				const [joined] = await database
					.select()
					.from(Db.loopsSyncJobs)
					.where(eq(Db.loopsSyncJobs.userId, ownerId));
				expect(joined).toBeDefined();
				expect(joined?.teammateJoinedAt).toBeNull();
				await apply(configuration, { ...existingRemote, state: "inactive" });
				const [removed] = await database
					.select()
					.from(Db.loopsSyncJobs)
					.where(eq(Db.loopsSyncJobs.userId, ownerId));
				expect(removed?.revision).toBe((joined?.revision ?? 0) + 1);
			} finally {
				if (prior === undefined) delete process.env.LOOPS_SYNC_ENABLED;
				else process.env.LOOPS_SYNC_ENABLED = prior;
			}
		});

		it("denies inactive directories while retaining memberships for recovery", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			const workos = {
				directorySync: {
					getDirectory: async () => ({
						id: configuration.directoryId,
						organizationId: configuration.workosOrganizationId,
						state: "inactive",
					}),
				},
			} as unknown as WorkOS;
			await syncClaimedDirectory(
				database,
				workos,
				configuration,
				Date.now() + 15_000,
			);
			expect(await memberships(record.userId)).toHaveLength(1);
			expect(
				await hasDirectoryAccess(
					record.userId,
					configuration.organizationId,
					database,
				),
			).toBe(false);
			await expect(
				requireDirectoryMembership(
					database,
					configuration.organizationId,
					remote.email ?? "",
					record.userId,
				),
			).rejects.toThrow("assign you");
		});
		it("lets removal win tied timestamps and prevents a same-version activation replay", async () => {
			const { configuration, remote } = await fixture();
			const record = await requireRecord(configuration, remote);
			await apply(configuration, { ...remote, state: "inactive" });
			await apply(configuration, remote);
			expect(await memberships(record.userId)).toHaveLength(0);
			expect(
				await hasDirectoryAccess(
					record.userId,
					configuration.organizationId,
					database,
				),
			).toBe(false);
		});
	},
);
