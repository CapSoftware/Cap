import { randomUUID } from "node:crypto";
import { resolveActiveOrganization } from "@cap/database/organization-pointer";
import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect, Exit, Logger, LogLevel, Option } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ database: undefined as unknown }));

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
}));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	class StorageReached {
		readonly _tag = "StorageReached";
	}
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getWritableAccessForUser: () => Effect.fail(new StorageReached()),
		}),
	}) {}
	return { Storage };
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
			expect(await record(userId, ownOrgId)).toBe(ACCEPTED);
			expect(await record(userId, oldOrgId)).toBe(DENIED);
		});

		it("lets the web recorder record into an organization the user can use and stores it", async () => {
			const { userId, oldOrgId, ownOrgId } =
				await removedMemberWithStalePointer();

			expect(await record(userId, oldOrgId)).toBe(DENIED);
			expect(await activeOrganizationOf(userId)).toBe(oldOrgId);

			expect(await record(userId, ownOrgId)).toBe(ACCEPTED);
			expect(await activeOrganizationOf(userId)).toBe(ownOrgId);
			expect(await record(userId, oldOrgId)).toBe(DENIED);
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
			expect(await record(userId, otherOrgId)).toBe(ACCEPTED);
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
			expect(await record(userId, deletedOrgId)).toBe(DENIED);
			expect(await record(userId, liveOrgId)).toBe(ACCEPTED);
		});

		it("returns nothing and leaves the pointer when no organization is left", async () => {
			const oldOrgId = await createOrganization(null);
			const userId = await createUser(oldOrgId);

			expect(Option.isNone(await bootstrap(userId))).toBe(true);
			expect(await activeOrganizationOf(userId)).toBe(oldOrgId);
			expect(await record(userId, oldOrgId)).toBe(DENIED);
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
			expect(await record(userId, ownOrgId)).toBe(ACCEPTED);
			expect(await record(userId, teamOrgId)).toBe(DENIED);
		});
	},
);
