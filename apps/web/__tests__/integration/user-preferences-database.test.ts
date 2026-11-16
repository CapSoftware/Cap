import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// users.preferences defaults to the JSON literal null (migration 0003). These
// run the real preference writers against a real migrated MySQL database on
// rows in each state a production account can be in.

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
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: vi.fn(async () => ({})),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

type Start = "json-null" | "sql-null" | Record<string, unknown>;

const createUser = async (start: Start) => {
	const userId = id();
	await database()
		.insert(Db.users)
		.values({
			id: userId as never,
			email: `${userId}@example.com`,
			name: "Member",
			activeOrganizationId: id() as never,
		});
	const value =
		start === "json-null"
			? sql`CAST('null' AS JSON)`
			: start === "sql-null"
				? sql`NULL`
				: sql`CAST(${JSON.stringify(start)} AS JSON)`;
	await database()
		.update(Db.users)
		.set({ preferences: value as never })
		.where(eq(Db.users.id, userId as never));
	return userId;
};

const storedPreferences = async (userId: string) => {
	const [row] = await database()
		.select({
			preferences: Db.users.preferences,
			type: sql<string | null>`JSON_TYPE(${Db.users.preferences})`,
		})
		.from(Db.users)
		.where(eq(Db.users.id, userId as never));
	return row;
};

const notifications = {
	pauseComments: true,
	pauseReplies: false,
	pauseViews: true,
	pauseReactions: false,
	pauseAnonViews: false,
};

describe.runIf(Boolean(databaseUrl))(
	"user preference writes against a real database",
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

		it("new accounts start with the JSON null preferences these writers must handle", async () => {
			const userId = id();
			await database()
				.insert(Db.users)
				.values({
					id: userId as never,
					email: `${userId}@example.com`,
					name: "Fresh",
					activeOrganizationId: id() as never,
				});
			expect((await storedPreferences(userId))?.type).toBe("NULL");
		});

		it.each<Start>(["json-null", "sql-null"])(
			"saves notification settings when preferences start as %s",
			async (start) => {
				const { updatePreferences } = await import(
					"@/actions/notifications/update-preferences"
				);
				fixture.sessionUserId = await createUser(start);
				await updatePreferences({ notifications });
				const row = await storedPreferences(fixture.sessionUserId);
				expect(row?.type).toBe("OBJECT");
				expect(row?.preferences).toEqual({ notifications });
			},
		);

		it("keeps other preference keys when saving notification settings", async () => {
			const { updatePreferences } = await import(
				"@/actions/notifications/update-preferences"
			);
			const mediaInputPolicy = { strikes: [{ at: 1, videoId: "v" }] };
			fixture.sessionUserId = await createUser({ mediaInputPolicy });
			await updatePreferences({ notifications });
			expect(
				(await storedPreferences(fixture.sessionUserId))?.preferences,
			).toEqual({ mediaInputPolicy, notifications });
		});

		it.each<Start>([
			"json-null",
			"sql-null",
			{ notifications },
			{ trackedEvents: {} },
		])(
			"marks a new signup tracked exactly once when preferences start as %j",
			async (start) => {
				const { checkAndMarkUserSignedUpTracked } = await import(
					"@/actions/analytics/track-user-signed-up"
				);
				fixture.sessionUserId = await createUser(start);
				expect(await checkAndMarkUserSignedUpTracked()).toEqual({
					shouldTrack: true,
				});
				expect(await checkAndMarkUserSignedUpTracked()).toEqual({
					shouldTrack: false,
				});
				const stored = (await storedPreferences(fixture.sessionUserId))
					?.preferences as Record<string, unknown>;
				expect(stored.trackedEvents).toEqual({ user_signed_up: true });
				if (typeof start === "object" && "notifications" in start)
					expect(stored.notifications).toEqual(notifications);
			},
		);

		it("suspends media processing after three strikes on a JSON null account", async () => {
			const { recordMediaInputPolicyStrike } = await import(
				"@/lib/media-input-policy-strikes"
			);
			const userId = await createUser("json-null");
			const orgId = id();
			const now = new Date();
			const results = [];
			for (let strike = 0; strike < 3; strike++) {
				const videoId = id();
				await database()
					.insert(Db.videos)
					.values({
						id: videoId as never,
						ownerId: userId as never,
						orgId: orgId as never,
						name: "Upload",
					} as never);
				results.push(
					await recordMediaInputPolicyStrike({
						videoId: videoId as Video.VideoId,
						now: new Date(now.getTime() + strike * 1000),
					}),
				);
			}
			expect(results.map((result) => result?.suspended)).toEqual([
				false,
				false,
				true,
			]);
			const stored = (await storedPreferences(userId))?.preferences as {
				mediaInputPolicy?: { strikes: unknown[]; suspendedAt?: string };
			};
			expect(stored.mediaInputPolicy?.strikes).toHaveLength(3);
			expect(stored.mediaInputPolicy?.suspendedAt).toBeDefined();
		});
	},
);
