import { randomUUID } from "node:crypto";
import {
	PERSONAL_ORGANIZATION_NAME,
	resolveActiveOrganization,
} from "@cap/database/organization-pointer";
import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	type Folder,
	Organisation,
	type Space,
	User,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect, Exit, Logger, LogLevel, Option } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	storageOrgIds: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	dub: {},
	userIsPro: () => false,
}));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	class StorageReached {
		readonly _tag = "StorageReached";
	}
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getWritableAccessForUser: (_userId: string, orgId: string) => {
				fixture.storageOrgIds.push(orgId);
				return Effect.fail(new StorageReached());
			},
		}),
	}) {}
	return { Storage };
});
vi.mock("@/lib/server", async () => {
	const { Effect, Layer } = await import("effect");
	const { Database } = await import("@cap/web-backend/src/Database");
	const { ImageUploads } = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, never>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(Database.Default),
					Effect.provide(Layer.succeed(ImageUploads, {} as never)),
				) as Effect.Effect<A, E, never>,
			),
	};
});
vi.mock("@cap/web-backend/src/Tinybird/index", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({}),
	}) {}
	return { Tinybird };
});

const { Videos } = await import("@cap/web-backend/src/Videos/index");
const { VideosPolicy } = await import(
	"@cap/web-backend/src/Videos/VideosPolicy"
);
const { VideosRepo } = await import("@cap/web-backend/src/Videos/VideosRepo");
const { Database } = await import("@cap/web-backend/src/Database");
const { Storage } = await import("@cap/web-backend/src/Storage/index");
const { Tinybird } = await import("@cap/web-backend/src/Tinybird/index");
const { Extensions } = await import(
	"@cap/web-backend/src/Extension/Extensions"
);
const { deleteOrganizationMembership } = await import(
	"@/lib/organization-member-removal"
);
const { getDashboardData } = await import(
	"@/app/(org)/dashboard/dashboard-data"
);
const { Folders } = await import("@cap/web-backend/src/Folders/index");
const { FoldersPolicy } = await import(
	"@cap/web-backend/src/Folders/FoldersPolicy"
);
const { FoldersRepo } = await import(
	"@cap/web-backend/src/Folders/FoldersRepo"
);

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

const createOrganization = async (
	ownerId: User.UserId | null,
	options?: { tombstoned?: boolean },
) => {
	const orgId = Organisation.OrganisationId.make(id());
	const owner = ownerId ?? User.UserId.make(id());
	if (!ownerId)
		await database()
			.insert(Db.users)
			.values({
				id: owner,
				email: `${owner}@example.com`,
				activeOrganizationId: orgId,
			});
	await database()
		.insert(Db.organizations)
		.values({
			id: orgId,
			name: `Org ${orgId}`,
			ownerId: owner,
			tombstoneAt: options?.tombstoned ? new Date() : null,
		});
	return orgId;
};

const addMember = async (
	orgId: Organisation.OrganisationId,
	userId: User.UserId,
	createdAt?: Date,
) => {
	const memberId = id();
	await database()
		.insert(Db.organizationMembers)
		.values({
			id: memberId,
			organizationId: orgId,
			userId,
			role: "member",
			...(createdAt ? { createdAt } : {}),
		});
	return memberId;
};

const createUser = async (
	activeOrganizationId: Organisation.OrganisationId,
) => {
	const userId = User.UserId.make(id());
	await database()
		.insert(Db.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			activeOrganizationId,
			defaultOrgId: activeOrganizationId,
		});
	return userId;
};

const pointersOf = async (userId: User.UserId) => {
	const [user] = await database()
		.select({
			activeOrganizationId: Db.users.activeOrganizationId,
			defaultOrgId: Db.users.defaultOrgId,
		})
		.from(Db.users)
		.where(eq(Db.users.id, userId));
	return user;
};

const ownedOrganizationsOf = (userId: User.UserId) =>
	database()
		.select({ id: Db.organizations.id, name: Db.organizations.name })
		.from(Db.organizations)
		.where(eq(Db.organizations.ownerId, userId));

const activeOrganizationOf = async (userId: User.UserId) => {
	const [user] = await database()
		.select({ activeOrganizationId: Db.users.activeOrganizationId })
		.from(Db.users)
		.where(eq(Db.users.id, userId));
	return user?.activeOrganizationId;
};

const currentUser = async (userId: User.UserId) => ({
	id: userId,
	email: `${userId}@example.com`,
	activeOrganizationId: Organisation.OrganisationId.make(
		(await activeOrganizationOf(userId)) ?? "",
	),
	iconUrlOrKey: Option.none(),
});

const bootstrap = async (userId: User.UserId) => {
	const user = await currentUser(userId);
	return Effect.flatMap(Extensions, (extensions) =>
		extensions.resolveBootstrapOrganization(user),
	).pipe(
		Effect.provide(Extensions.DefaultWithoutDependencies),
		Effect.provide(Database.Default),
		Effect.runPromise,
	);
};

const record = async (
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
) => {
	const exit = await Effect.flatMap(Videos, (videos) =>
		videos.createInstantRecording({ orgId, folderId: Option.none() }),
	).pipe(
		Effect.provide(Videos.DefaultWithoutDependencies),
		Effect.provide([
			VideosPolicy.Default,
			VideosRepo.Default,
			Storage.Default,
			Tinybird.Default,
			Database.Default,
		]),
		Effect.provideService(CurrentUser, await currentUser(userId)),
		Logger.withMinimumLogLevel(LogLevel.None),
		Effect.runPromiseExit,
	);
	if (Exit.isSuccess(exit)) return "created";
	const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
	return failure && typeof failure === "object" && "_tag" in failure
		? String(failure._tag)
		: "defect";
};

// The storage mock records the organization each accepted recording targets.
const recordInto = async (
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
) => {
	fixture.storageOrgIds.length = 0;
	const result = await record(userId, orgId);
	if (result !== ACCEPTED) return result;
	expect(fixture.storageOrgIds).toHaveLength(1);
	return fixture.storageOrgIds[0];
};

const createFolder = async (
	userId: User.UserId,
	spaceId?: Space.SpaceIdOrOrganisationId,
) => {
	const exit = await Effect.flatMap(Folders, (folders) =>
		folders.create({
			name: "Root",
			color: "normal",
			spaceId: Option.fromNullable(spaceId),
			parentId: Option.none<Folder.FolderId>(),
		}),
	).pipe(
		Effect.provide(Folders.DefaultWithoutDependencies),
		Effect.provide([FoldersPolicy.Default, FoldersRepo.Default]),
		Effect.provide(Database.Default),
		Effect.provideService(CurrentUser, await currentUser(userId)),
		Logger.withMinimumLogLevel(LogLevel.None),
		Effect.runPromiseExit,
	);
	if (Exit.isSuccess(exit)) return "created";
	const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
	return failure && typeof failure === "object" && "_tag" in failure
		? String(failure._tag)
		: "defect";
};

const foldersIn = (orgId: Organisation.OrganisationId, userId: User.UserId) =>
	database()
		.select({ id: Db.folders.id })
		.from(Db.folders)
		.where(
			and(
				eq(Db.folders.organizationId, orgId),
				eq(Db.folders.createdById, userId),
			),
		);

const loadDashboard = async (
	userId: User.UserId,
	canCreatePersonalOrganization: boolean,
) => {
	const [user] = await database()
		.select()
		.from(Db.users)
		.where(eq(Db.users.id, userId));
	if (!user) throw new Error("Missing user.");
	return getDashboardData(user, {
		canCreatePersonalOrganization: async () => canCreatePersonalOrganization,
	});
};

const expectSinglePersonalOrganization = async (userId: User.UserId) => {
	const owned = await ownedOrganizationsOf(userId);
	expect(owned).toHaveLength(1);
	const [organization] = owned;
	if (!organization) throw new Error("No personal organization.");
	expect(organization.name).toBe(PERSONAL_ORGANIZATION_NAME);
	const memberships = await database()
		.select({ role: Db.organizationMembers.role })
		.from(Db.organizationMembers)
		.where(
			and(
				eq(Db.organizationMembers.userId, userId),
				eq(Db.organizationMembers.organizationId, organization.id),
			),
		);
	expect(memberships).toEqual([{ role: "owner" }]);
	expect(await pointersOf(userId)).toEqual({
		activeOrganizationId: organization.id,
		defaultOrgId: organization.id,
	});
	return organization.id;
};

// Recording reaches the storage quota check only after the organization gate.
const ACCEPTED = "StorageReached";
const DENIED = "PolicyDenied";

const removedMemberWithStalePointer = async () => {
	const userId = User.UserId.make(id());
	const oldOrgId = await createOrganization(null);
	const ownOrgId = await createOrganization(userId);
	await database()
		.insert(Db.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			activeOrganizationId: oldOrgId,
			defaultOrgId: oldOrgId,
		});
	return { userId, oldOrgId, ownOrgId };
};

describe.runIf(Boolean(databaseUrl))(
	"organization pointers against a real database",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			)
				throw new Error("These tests require a session-scoped local database.");
			pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
			fixture.database = drizzle(pool);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("bootstraps the extension into the user's own organization and records there", async () => {
			const { userId, oldOrgId, ownOrgId } =
				await removedMemberWithStalePointer();

			const organization = await bootstrap(userId);

			expect(Option.getOrNull(organization)?.id).toBe(ownOrgId);
			expect(await activeOrganizationOf(userId)).toBe(ownOrgId);
			expect(await recordInto(userId, ownOrgId)).toBe(ownOrgId);
			expect(await recordInto(userId, oldOrgId)).toBe(ownOrgId);
		});

		it("lets the web recorder record into an organization the user can use and stores it", async () => {
			const { userId, oldOrgId, ownOrgId } =
				await removedMemberWithStalePointer();

			expect(await recordInto(userId, ownOrgId)).toBe(ownOrgId);
			expect(await activeOrganizationOf(userId)).toBe(ownOrgId);
			expect(await recordInto(userId, oldOrgId)).toBe(ownOrgId);
		});

		it("records a stale organization request into the user's own organization", async () => {
			const { userId, oldOrgId, ownOrgId } =
				await removedMemberWithStalePointer();

			expect(await recordInto(userId, oldOrgId)).toBe(ownOrgId);
			expect(await activeOrganizationOf(userId)).toBe(ownOrgId);
			expect(await ownedOrganizationsOf(userId)).toHaveLength(1);
		});

		it("keeps requiring the active organization while it is usable", async () => {
			const userId = User.UserId.make(id());
			const ownOrgId = await createOrganization(userId);
			const otherOrgId = await createOrganization(null);
			await addMember(otherOrgId, userId);
			await database()
				.insert(Db.users)
				.values({
					id: userId,
					email: `${userId}@example.com`,
					activeOrganizationId: otherOrgId,
				});

			expect(Option.getOrNull(await bootstrap(userId))?.id).toBe(otherOrgId);
			expect(await record(userId, ownOrgId)).toBe(DENIED);
			expect(await recordInto(userId, otherOrgId)).toBe(otherOrgId);
			expect(await activeOrganizationOf(userId)).toBe(otherOrgId);
		});

		it("falls back to the oldest live membership when the user owns nothing", async () => {
			const oldOrgId = await createOrganization(null);
			const deletedOrgId = await createOrganization(null, {
				tombstoned: true,
			});
			const olderOrgId = await createOrganization(null);
			const newerOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);
			await addMember(deletedOrgId, userId, new Date("2024-01-01T00:00:00Z"));
			await addMember(newerOrgId, userId, new Date("2025-06-01T00:00:00Z"));
			await addMember(olderOrgId, userId, new Date("2025-01-01T00:00:00Z"));

			expect(Option.getOrNull(await bootstrap(userId))?.id).toBe(olderOrgId);
			expect(await activeOrganizationOf(userId)).toBe(olderOrgId);
		});

		it("moves off a deleted active organization the user owned", async () => {
			const userId = User.UserId.make(id());
			const deletedOrgId = await createOrganization(userId, {
				tombstoned: true,
			});
			const liveOrgId = await createOrganization(userId);
			await database()
				.insert(Db.users)
				.values({
					id: userId,
					email: `${userId}@example.com`,
					activeOrganizationId: deletedOrgId,
				});

			expect(Option.getOrNull(await bootstrap(userId))?.id).toBe(liveOrgId);
			expect(await recordInto(userId, deletedOrgId)).toBe(liveOrgId);
			expect(await recordInto(userId, liveOrgId)).toBe(liveOrgId);
		});

		it("bootstraps a removed member with no organization into a new personal organization", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			const organization = Option.getOrNull(await bootstrap(userId));
			const personalOrgId = await expectSinglePersonalOrganization(userId);
			expect(organization?.id).toBe(personalOrgId);
			expect(personalOrgId).not.toBe(oldOrgId);

			expect(await recordInto(userId, personalOrgId)).toBe(personalOrgId);
			expect(await recordInto(userId, oldOrgId)).toBe(personalOrgId);
			expect(Option.getOrNull(await bootstrap(userId))?.id).toBe(personalOrgId);
			await expectSinglePersonalOrganization(userId);
		});

		it("records a removed member with no organization from the web recorder into a new personal organization", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			const target = await recordInto(userId, oldOrgId);
			const personalOrgId = await expectSinglePersonalOrganization(userId);
			expect(target).toBe(personalOrgId);
			expect(target).not.toBe(oldOrgId);
			expect(await recordInto(userId, oldOrgId)).toBe(personalOrgId);
			await expectSinglePersonalOrganization(userId);
		});

		it("handles an empty pointer the same way", async () => {
			const userId = await createUser(Organisation.OrganisationId.make(""));

			const personalOrgId = Option.getOrNull(await bootstrap(userId))?.id;
			expect(personalOrgId).toBe(
				await expectSinglePersonalOrganization(userId),
			);
		});

		it("creates exactly one personal organization under concurrent bootstrap and recording", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			const results = await Promise.all([
				bootstrap(userId),
				bootstrap(userId),
				bootstrap(userId),
				bootstrap(userId),
				record(userId, oldOrgId),
				record(userId, oldOrgId),
			]);

			const personalOrgId = await expectSinglePersonalOrganization(userId);
			for (const result of results.slice(0, 4))
				expect(
					Option.getOrNull(result as Option.Option<{ id: string }>)?.id,
				).toBe(personalOrgId);
			expect(results.slice(4)).toEqual([ACCEPTED, ACCEPTED]);
		});

		it("refuses a root folder in an organization the user was removed from", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			expect(await createFolder(userId)).toBe(DENIED);
			expect(await createFolder(userId, oldOrgId)).toBe(DENIED);
			expect(await foldersIn(oldOrgId, userId)).toEqual([]);

			const personalOrgId = Option.getOrNull(await bootstrap(userId))?.id;
			if (!personalOrgId) throw new Error("No personal organization.");
			expect(await createFolder(userId)).toBe("created");
			expect(await foldersIn(personalOrgId, userId)).toHaveLength(1);
			expect(await foldersIn(oldOrgId, userId)).toEqual([]);
		});

		it("shows a removed member with no organization a new personal organization on the dashboard", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			const [first, second] = await Promise.all([
				loadDashboard(userId, true),
				loadDashboard(userId, true),
			]);
			const personalOrgId = await expectSinglePersonalOrganization(userId);
			expect(first.activeOrganizationId).toBe(personalOrgId);
			expect(second.activeOrganizationId).toBe(personalOrgId);
			expect(
				first.organizationSelect.map(
					(organization) => organization.organization.id,
				),
			).toEqual([personalOrgId]);
			expect(await recordInto(userId, personalOrgId)).toBe(personalOrgId);
		});

		it("does not create an organization on the dashboard while an invite is pending", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			const data = await loadDashboard(userId, false);

			expect(data.activeOrganizationId).toBeNull();
			expect(await ownedOrganizationsOf(userId)).toEqual([]);
		});

		it("still creates root folders in an organization the user belongs to", async () => {
			const teamOrgId = await createOrganization(null);
			const userId = await createUser(teamOrgId);
			await addMember(teamOrgId, userId);

			expect(await createFolder(userId)).toBe("created");
			expect(await foldersIn(teamOrgId, userId)).toHaveLength(1);
		});

		it("does not overwrite an organization switch made after the check", async () => {
			const { userId, oldOrgId } = await removedMemberWithStalePointer();
			const switchedOrgId = await createOrganization(null);
			await addMember(switchedOrgId, userId);
			await database()
				.update(Db.users)
				.set({ activeOrganizationId: switchedOrgId })
				.where(eq(Db.users.id, userId));

			await resolveActiveOrganization(database(), {
				id: userId,
				activeOrganizationId: oldOrgId,
			});

			expect(await activeOrganizationOf(userId)).toBe(switchedOrgId);
		});

		it("lets a member removed through the dashboard keep recording into their own organization", async () => {
			const ownerId = User.UserId.make(id());
			const teamOrgId = await createOrganization(ownerId);
			const userId = User.UserId.make(id());
			const ownOrgId = await createOrganization(userId);
			const memberId = await addMember(teamOrgId, userId);
			await database()
				.insert(Db.users)
				.values({
					id: userId,
					email: `${userId}@example.com`,
					activeOrganizationId: teamOrgId,
				});

			await database().transaction((tx) =>
				deleteOrganizationMembership(tx, teamOrgId, {
					id: memberId,
					userId,
					hasProSeat: false,
					email: `${userId}@example.com`,
				}),
			);

			expect(Option.getOrNull(await bootstrap(userId))?.id).toBe(ownOrgId);
			expect(await recordInto(userId, ownOrgId)).toBe(ownOrgId);
			expect(await recordInto(userId, teamOrgId)).toBe(ownOrgId);
		});

		it("gives a member removed from their only organization a personal organization on next use", async () => {
			const ownerId = User.UserId.make(id());
			const teamOrgId = await createOrganization(ownerId);
			const userId = User.UserId.make(id());
			const memberId = await addMember(teamOrgId, userId);
			await database()
				.insert(Db.users)
				.values({
					id: userId,
					email: `${userId}@example.com`,
					activeOrganizationId: teamOrgId,
					defaultOrgId: teamOrgId,
				});

			await database().transaction((tx) =>
				deleteOrganizationMembership(tx, teamOrgId, {
					id: memberId,
					userId,
					hasProSeat: false,
					email: `${userId}@example.com`,
				}),
			);
			expect(await pointersOf(userId)).toEqual({
				activeOrganizationId: "",
				defaultOrgId: null,
			});

			const target = await recordInto(userId, teamOrgId);
			expect(target).toBe(await expectSinglePersonalOrganization(userId));
			expect(target).not.toBe(teamOrgId);
		});
	},
);
