import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The daily meeting audio cap against a real migrated MySQL database: the
// conditional update is what keeps concurrent clips within the cap.

const fixture = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));

const usage = await import("@/lib/meetings/audio-usage");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const database = () => fixture.database as MySql2Database;
const newUser = () => randomUUID().replaceAll("-", "").slice(0, 15);

const rows = (userId: string) =>
	database()
		.select()
		.from(Db.meetingAudioUsage)
		.where(eq(Db.meetingAudioUsage.userId, userId as never));

describe.runIf(Boolean(databaseUrl))("daily meeting audio in MySQL", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createPool({ uri: databaseUrl, connectionLimit: 12 });
		fixture.database = drizzle(pool);
	});

	afterAll(async () => {
		await pool?.end();
	});

	it("never lets concurrent clips pass the cap together", async () => {
		const now = new Date("2026-11-24T12:00:00Z");
		for (let round = 0; round < 5; round++) {
			const userId = newUser();
			const results = await Promise.all(
				Array.from({ length: 12 }, () =>
					usage.consumeDailyAudioUnits(userId, 3, 20, now),
				),
			);
			expect(results.filter((result) => result.allowed)).toHaveLength(6);
			expect(results.filter((result) => result.allowed === false)).toHaveLength(
				6,
			);
			expect(await rows(userId)).toMatchObject([
				{ day: "2026-11-24", units: 18 },
			]);
		}
	});

	it("fills the cap exactly and starts again the next UTC day", async () => {
		const userId = newUser();
		const day = new Date("2026-11-24T23:59:30Z");
		expect(await usage.consumeDailyAudioUnits(userId, 7, 10, day)).toEqual({
			allowed: true,
		});
		expect(await usage.consumeDailyAudioUnits(userId, 3, 10, day)).toEqual({
			allowed: true,
		});
		expect(await usage.consumeDailyAudioUnits(userId, 1, 10, day)).toEqual({
			allowed: false,
			retryAfterSeconds: 30,
		});
		const next = new Date("2026-11-25T00:00:01Z");
		expect(await usage.consumeDailyAudioUnits(userId, 10, 10, next)).toEqual({
			allowed: true,
		});
		expect(
			(await rows(userId)).map((row) => [row.day, row.units]).sort(),
		).toEqual([
			["2026-11-24", 10],
			["2026-11-25", 10],
		]);
	});

	it("keeps users apart", async () => {
		const now = new Date("2026-11-24T08:00:00Z");
		const first = newUser();
		const second = newUser();
		expect(await usage.consumeDailyAudioUnits(first, 5, 5, now)).toEqual({
			allowed: true,
		});
		expect((await usage.consumeDailyAudioUnits(first, 1, 5, now)).allowed).toBe(
			false,
		);
		expect(await usage.consumeDailyAudioUnits(second, 5, 5, now)).toEqual({
			allowed: true,
		});
	});
});
