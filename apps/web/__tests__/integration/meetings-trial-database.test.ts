import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Free meeting notes against a real migrated MySQL database: the slot key is
// what keeps concurrent claims within the limit.

const fixture = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));

const trial = await import("@/lib/meetings/trial");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const database = () => fixture.database as MySql2Database;
const newUser = () => randomUUID().replaceAll("-", "").slice(0, 15);

const rows = (userId: string) =>
	database()
		.select()
		.from(Db.meetingNotesTrialUses)
		.where(eq(Db.meetingNotesTrialUses.userId, userId as never));

describe.runIf(Boolean(databaseUrl))("free meeting notes in MySQL", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createPool({ uri: databaseUrl, connectionLimit: 12 });
		fixture.database = drizzle(pool);
	});

	afterAll(async () => {
		await pool?.end();
	});

	it("never grants more than the limit to concurrent claims", async () => {
		for (let round = 0; round < 10; round++) {
			const userId = newUser();
			await trial.claimTrialMeeting(userId, "m-first");
			await trial.claimTrialMeeting(userId, "m-second");
			const results = await Promise.all(
				["z", "a", "m", "b", "y"].map((id) =>
					trial.claimTrialMeeting(userId, `m-${id}`),
				),
			);
			expect(results.filter((result) => result === "claimed")).toHaveLength(1);
			expect(await rows(userId)).toHaveLength(3);
		}
	});

	it("lets a written meeting be rewritten after the free meetings are used", async () => {
		const userId = newUser();
		for (const id of ["a", "b", "c"]) {
			expect(await trial.claimTrialMeeting(userId, id)).toBe("claimed");
			await trial.completeTrialMeeting(userId, id);
		}
		expect(await trial.claimTrialMeeting(userId, "d")).toBe("exhausted");
		expect(await trial.claimTrialMeeting(userId, "b")).toBe("already_claimed");
		expect(await trial.trialRemaining(userId)).toBe(0);
	});

	it("caps rewrites and questions per free meeting", async () => {
		const userId = newUser();
		expect(await trial.claimTrialMeeting(userId, "a")).toBe("claimed");
		await trial.completeTrialMeeting(userId, "a");
		for (let run = 1; run < trial.TRIAL_NOTES_RUNS_PER_MEETING; run++)
			expect(await trial.claimTrialMeeting(userId, "a")).toBe(
				"already_claimed",
			);
		expect(await trial.claimTrialMeeting(userId, "a")).toBe("runs_exhausted");

		for (let ask = 0; ask < trial.TRIAL_ASKS_PER_MEETING; ask++)
			expect(await trial.spendTrialAsk(userId, "a")).toBe(true);
		expect(await trial.spendTrialAsk(userId, "a")).toBe(false);
		expect(await trial.spendTrialAsk(userId, "never-claimed")).toBe(false);
	});

	it("keeps a second request for a pending meeting from sharing its claim", async () => {
		const userId = newUser();
		expect(await trial.claimTrialMeeting(userId, "a")).toBe("claimed");
		expect(await trial.claimTrialMeeting(userId, "a")).toBe("busy");
		expect(await trial.spendTrialAsk(userId, "a")).toBe(false);

		await trial.releaseTrialMeeting(userId, "a");
		expect(await rows(userId)).toHaveLength(0);
		expect(await trial.trialRemaining(userId)).toBe(3);
	});

	it("does not give back a meeting that was written once", async () => {
		const userId = newUser();
		await trial.claimTrialMeeting(userId, "a");
		await trial.completeTrialMeeting(userId, "a");
		expect(await trial.claimTrialMeeting(userId, "a")).toBe("already_claimed");
		await trial.releaseTrialMeeting(userId, "a");
		expect(await rows(userId)).toHaveLength(1);
		expect(await trial.spendTrialAsk(userId, "a")).toBe(true);
	});

	it("takes over a pending claim its request abandoned", async () => {
		const userId = newUser();
		const longAgo = new Date(Date.now() - trial.TRIAL_PENDING_STALE_MS - 1_000);
		await trial.claimTrialMeeting(userId, "a", 3, longAgo);
		expect(await trial.claimTrialMeeting(userId, "a")).toBe("already_claimed");
	});

	it("reuses a slot a failed first write-up gave back", async () => {
		const userId = newUser();
		for (const id of ["a", "b", "c"]) await trial.claimTrialMeeting(userId, id);
		await trial.releaseTrialMeeting(userId, "a");
		expect(await trial.claimTrialMeeting(userId, "d")).toBe("claimed");
		const slots = (await rows(userId)).map((row) => row.slot).sort();
		expect(slots).toEqual([1, 2, 3]);
	});
});
