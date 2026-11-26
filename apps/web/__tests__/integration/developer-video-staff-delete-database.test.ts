import { randomUUID } from "node:crypto";
import { developerApps, developerVideos } from "@cap/database/schema";
import { eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	deleteObjects: vi.fn(async (_prefix: string) => 3),
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@/lib/developer-video-storage", () => ({
	deleteDeveloperVideoObjects: fixture.deleteObjects,
	developerVideoPrefix: (video: { appId: string; id: string }) =>
		`developer/${video.appId}/${video.id}/`,
}));

const { purgeDeletedDeveloperVideoNow, purgeDeletedDeveloperVideos } =
	await import("@/lib/developer-video-purge");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

describe.runIf(Boolean(databaseUrl))(
	"staff delete purge against a real database",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error("These tests require a session-scoped local database.");
			}
			pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
			fixture.database = drizzle(pool);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("purges at once and leaves the late write pass to the cron", async () => {
			const appId = id();
			const videoId = id();
			await database()
				.insert(developerApps)
				.values({
					id: appId,
					ownerId: id() as never,
					name: "Staff delete fixture",
					environment: "development",
				});
			await database()
				.insert(developerVideos)
				.values({
					id: videoId,
					appId,
					name: "Fixture",
					status: "ready",
					deletedAt: sql`NOW()` as never,
				});

			expect(await purgeDeletedDeveloperVideoNow({ id: videoId, appId })).toBe(
				true,
			);
			expect(fixture.deleteObjects.mock.calls).toEqual([
				[`developer/${appId}/${videoId}/`],
			]);
			const selected = async () => {
				fixture.deleteObjects.mockClear();
				await purgeDeletedDeveloperVideos(10_000);
				return fixture.deleteObjects.mock.calls.some(
					([prefix]) => prefix === `developer/${appId}/${videoId}/`,
				);
			};
			expect(await selected()).toBe(false);

			await database()
				.update(developerVideos)
				.set({
					deletedAt: sql`${developerVideos.deletedAt} - INTERVAL 5 HOUR`,
					filesDeletedAt: sql`${developerVideos.filesDeletedAt} - INTERVAL 5 HOUR`,
				})
				.where(eq(developerVideos.id, videoId));
			expect(await selected()).toBe(true);
			expect(await selected()).toBe(false);

			await database()
				.delete(developerVideos)
				.where(eq(developerVideos.id, videoId));
			await database().delete(developerApps).where(eq(developerApps.id, appId));
		});
	},
);
