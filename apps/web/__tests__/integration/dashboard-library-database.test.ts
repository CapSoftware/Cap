import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	sessionUserId: "",
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => {
		const [user] = await (fixture.database as MySql2Database)
			.select()
			.from(Db.users)
			.where(eq(Db.users.id, fixture.sessionUserId as never));
		return user ?? null;
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

const createUser = async (orgId: string, preferences?: "json-null") => {
	const userId = id();
	await database()
		.insert(Db.users)
		.values({
			id: userId as never,
			email: `${userId}@example.com`,
			name: `Member ${userId.slice(0, 4)}`,
			activeOrganizationId: orgId as never,
		});
	if (preferences === "json-null")
		await database()
			.update(Db.users)
			.set({ preferences: sql`CAST('null' AS JSON)` as never })
			.where(eq(Db.users.id, userId as never));
	return userId;
};

const createOrg = async () => {
	const orgId = id();
	const ownerId = await createUser(orgId);
	await database()
		.insert(Db.organizations)
		.values({ id: orgId as never, name: "Acme", ownerId: ownerId as never });
	return { orgId, ownerId };
};

const addMember = async (
	orgId: string,
	role: "member" | "admin" = "member",
) => {
	const userId = await createUser(orgId);
	await database()
		.insert(Db.organizationMembers)
		.values({
			id: id(),
			userId: userId as never,
			organizationId: orgId as never,
			role: role as never,
		});
	return userId;
};

const createVideo = async (
	ownerId: string,
	orgId: string,
	values: Partial<typeof Db.videos.$inferInsert> = {},
) => {
	const videoId = id();
	await database()
		.insert(Db.videos)
		.values({
			id: videoId as never,
			ownerId: ownerId as never,
			orgId: orgId as never,
			name: `Video ${videoId.slice(0, 4)}`,
			...values,
		});
	return videoId as Video.VideoId;
};

describe.runIf(Boolean(databaseUrl))(
	"dashboard library actions against a real database",
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
			Object.assign(process.env, {
				NEXT_PUBLIC_WEB_URL: "http://localhost",
				WEB_URL: "http://localhost",
				DATABASE_URL: databaseUrl,
				NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
				NEXTAUTH_URL: "http://localhost",
				CAP_AWS_BUCKET: "synthetic",
				CAP_AWS_REGION: "us-east-1",
				CAP_AWS_ACCESS_KEY: "synthetic",
				CAP_AWS_SECRET_KEY: "synthetic",
				NODE_ENV: "test",
			});
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("saves the page size on a JSON null account and keeps other keys", async () => {
			const { setDashboardPageSize } = await import("@/actions/caps/page-size");
			const { orgId } = await createOrg();
			fixture.sessionUserId = await createUser(orgId, "json-null");
			await setDashboardPageSize(60);
			await database()
				.update(Db.users)
				.set({
					preferences: sql`JSON_SET(preferences, '$.notifications', JSON_OBJECT('pauseViews', true))`,
				})
				.where(eq(Db.users.id, fixture.sessionUserId as never));
			await setDashboardPageSize(100);
			const [row] = await database()
				.select({ preferences: Db.users.preferences })
				.from(Db.users)
				.where(eq(Db.users.id, fixture.sessionUserId as never));
			expect(row?.preferences).toEqual({
				dashboard: { pageSize: 100 },
				notifications: { pauseViews: true },
			});
			await expect(setDashboardPageSize(999)).rejects.toThrow();
		});

		it("archives only the owner's Caps, keeps updatedAt, and hides them from My Caps", async () => {
			const { setVideosArchived } = await import("@/actions/videos/archive");
			const { listCapIdsInView } = await import("@/actions/caps/list-view-ids");
			const { orgId, ownerId } = await createOrg();
			const otherId = await addMember(orgId);
			const updatedAt = new Date("2026-01-02T03:04:05Z");
			const mine = await createVideo(ownerId, orgId, { updatedAt });
			const kept = await createVideo(ownerId, orgId);
			const theirs = await createVideo(otherId, orgId);
			fixture.sessionUserId = ownerId;

			expect(
				await setVideosArchived({ videoIds: [mine, theirs], archived: true }),
			).toEqual({ updated: 1 });

			const rows = await database()
				.select({
					id: Db.videos.id,
					archivedAt: Db.videos.archivedAt,
					updatedAt: Db.videos.updatedAt,
				})
				.from(Db.videos)
				.where(inArray(Db.videos.id, [mine, theirs]));
			const byId = new Map(rows.map((row) => [row.id, row]));
			expect(byId.get(mine)?.archivedAt).toBeInstanceOf(Date);
			expect(byId.get(mine)?.updatedAt.toISOString()).toBe(
				updatedAt.toISOString(),
			);
			expect(byId.get(theirs)?.archivedAt).toBeNull();

			expect((await listCapIdsInView({ type: "personal" })).ids.sort()).toEqual(
				[kept].sort(),
			);
			expect(await listCapIdsInView({ type: "archived" })).toEqual({
				ids: [mine],
				truncated: false,
			});

			expect(
				await setVideosArchived({ videoIds: [mine], archived: false }),
			).toEqual({ updated: 1 });
			expect((await listCapIdsInView({ type: "personal" })).ids.sort()).toEqual(
				[mine, kept].sort(),
			);
		});

		it("persists a custom space order for everyone and only lets managers change it", async () => {
			const { reorderSpaceVideos, setSpaceVideoOrder } = await import(
				"@/actions/spaces/video-order"
			);
			const { getSpaceRootVideoOrder } = await import(
				"@/lib/space-video-order-query"
			);
			const { listCapIdsInView } = await import("@/actions/caps/list-view-ids");
			const { orgId, ownerId } = await createOrg();
			const memberId = await addMember(orgId);
			const spaceId = id();
			await database()
				.insert(Db.spaces)
				.values({
					id: spaceId as never,
					name: "Onboarding",
					organizationId: orgId as never,
					createdById: ownerId as never,
					settings: { disableComments: true },
				});
			await database()
				.insert(Db.spaceMembers)
				.values({
					id: id(),
					spaceId: spaceId as never,
					userId: memberId as never,
					role: "member",
				});
			const videoIds: Video.VideoId[] = [];
			for (let day = 1; day <= 4; day++) {
				const videoId = await createVideo(ownerId, orgId, {
					createdAt: new Date(`2026-03-0${day}T00:00:00Z`),
				});
				videoIds.push(videoId);
				await database()
					.insert(Db.spaceVideos)
					.values({
						id: id(),
						spaceId: spaceId as never,
						videoId,
						addedById: ownerId as never,
					});
			}
			const [v1, v2, v3, v4] = videoIds as [
				Video.VideoId,
				Video.VideoId,
				Video.VideoId,
				Video.VideoId,
			];
			const order = async (mode: "newest" | "custom") =>
				(await getSpaceRootVideoOrder(spaceId as never, mode)).map(
					(row) => row.id,
				);

			expect(await order("newest")).toEqual([v4, v3, v2, v1]);

			fixture.sessionUserId = memberId;
			await expect(
				reorderSpaceVideos({
					spaceId,
					videoIds: [v1],
					placement: { type: "start" },
				}),
			).rejects.toThrow();
			await expect(setSpaceVideoOrder(spaceId, "custom")).rejects.toThrow();
			await expect(
				listCapIdsInView({ type: "space", spaceId }),
			).rejects.toThrow();

			fixture.sessionUserId = ownerId;
			await reorderSpaceVideos({
				spaceId,
				videoIds: [v1],
				placement: { type: "start" },
			});
			expect(await order("custom")).toEqual([v1, v4, v3, v2]);

			await reorderSpaceVideos({
				spaceId,
				videoIds: [v2],
				placement: { type: "before", targetId: v4 },
			});
			expect(await order("custom")).toEqual([v1, v2, v4, v3]);

			const [space] = await database()
				.select({ settings: Db.spaces.settings })
				.from(Db.spaces)
				.where(eq(Db.spaces.id, spaceId as never));
			expect(space?.settings).toEqual({
				disableComments: true,
				videoOrder: "custom",
			});

			const v5 = await createVideo(ownerId, orgId);
			await database()
				.insert(Db.spaceVideos)
				.values({
					id: id(),
					spaceId: spaceId as never,
					videoId: v5,
					addedById: ownerId as never,
				});
			expect(await order("custom")).toEqual([v5, v1, v2, v4, v3]);

			await Promise.all([
				reorderSpaceVideos({
					spaceId,
					videoIds: [v3],
					placement: { type: "start" },
				}),
				reorderSpaceVideos({
					spaceId,
					videoIds: [v4],
					placement: { type: "start" },
				}),
			]);
			const positions = await database()
				.select({ position: Db.spaceVideos.position })
				.from(Db.spaceVideos)
				.where(eq(Db.spaceVideos.spaceId, spaceId as never));
			expect(
				positions
					.map((row) => row.position)
					.sort((a, b) => Number(a) - Number(b)),
			).toEqual([0, 1, 2, 3, 4]);
			expect((await order("custom")).slice(0, 2).sort()).toEqual(
				[v3, v4].sort(),
			);

			expect((await listCapIdsInView({ type: "space", spaceId })).ids).toEqual(
				await order("custom"),
			);

			await setSpaceVideoOrder(spaceId, "oldest");
			expect((await listCapIdsInView({ type: "space", spaceId })).ids).toEqual([
				v1,
				v2,
				v3,
				v4,
				v5,
			]);
		}, 120_000);

		it("summarises Loom imports by member for admins only", async () => {
			const { getLoomImportOverview } = await import(
				"@/actions/loom-import-overview"
			);
			const { orgId, ownerId } = await createOrg();
			const adminId = await addMember(orgId, "admin");
			const memberId = await addMember(orgId);
			const phases: Array<[string, string | null]> = [
				[ownerId, null],
				[ownerId, "error"],
				[memberId, "uploading"],
				[memberId, "processing"],
				[memberId, "complete"],
			];
			for (const [owner, phase] of phases) {
				const videoId = await createVideo(owner, orgId);
				await database()
					.insert(Db.importedVideos)
					.values({
						id: videoId,
						orgId: orgId as never,
						source: "loom",
						sourceId: id(),
					});
				if (phase)
					await database()
						.insert(Db.videoUploads)
						.values({ videoId, phase: phase as never });
			}
			await createVideo(memberId, orgId);

			fixture.sessionUserId = memberId;
			await expect(getLoomImportOverview(orgId)).rejects.toThrow();

			fixture.sessionUserId = adminId;
			const overview = await getLoomImportOverview(orgId);
			expect(overview.totals).toEqual({
				queued: 1,
				importing: 1,
				done: 2,
				failed: 1,
				total: 5,
			});
			const byUser = new Map(overview.members.map((m) => [m.userId, m]));
			expect(byUser.get(ownerId)).toMatchObject({ done: 1, failed: 1 });
			expect(byUser.get(memberId)).toMatchObject({
				queued: 1,
				importing: 1,
				done: 1,
			});
			expect(overview.attention.map((row) => row.state)).toEqual([
				"failed",
				expect.any(String),
				expect.any(String),
			]);
		});
	},
);
