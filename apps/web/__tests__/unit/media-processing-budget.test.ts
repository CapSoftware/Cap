import { beforeEach, expect, it, vi } from "vitest";
import {
	getMediaProcessingReservation,
	reserveMediaProcessingBudget,
} from "@/lib/media-processing-budget";

const state = vi.hoisted(() => ({
	rows: new Map<
		string,
		{ id: string; limitBytes: number; reservedBytes: number }
	>(),
}));
vi.mock("@cap/database/schema", () => ({
	mediaProcessingBudgets: {
		id: "id",
		reservedBytes: "reservedBytes",
		expiresAt: "expiresAt",
	},
}));
vi.mock("drizzle-orm", () => ({
	asc: (value: unknown) => value,
	lt: vi.fn(),
	inArray: (_column: unknown, ids: string[]) => ids,
	sql: (_strings: TemplateStringsArray, ...values: unknown[]) => values,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async (run: (tx: unknown) => Promise<number>) =>
			run({
				insert: () => ({
					values: (rows: Array<{ id: string; limitBytes: number }>) => ({
						onDuplicateKeyUpdate: async () => {
							for (const row of rows)
								if (!state.rows.has(row.id))
									state.rows.set(row.id, { ...row, reservedBytes: 0 });
						},
					}),
				}),
				select: () => ({
					from: () => ({
						where: (ids: string[]) => ({
							orderBy: () => ({
								for: async () => ids.map((id) => state.rows.get(id)),
							}),
						}),
					}),
				}),
				update: () => ({
					set: (values: { reservedBytes: [unknown, number] }) => ({
						where: async (ids: string[]) => {
							for (const id of ids) {
								const row = state.rows.get(id);
								if (row) row.reservedBytes += values.reservedBytes[1];
							}
						},
					}),
				}),
			}),
	}),
}));
beforeEach(() => state.rows.clear());

it("processes unrelated recordings regardless of the former daily allowance", async () => {
	vi.stubEnv("MEDIA_PROCESSING_DAILY_BUDGET_GIB", "1");
	try {
		for (let index = 0; index < 10; index++) {
			await expect(
				reserveMediaProcessingBudget({
					videoId: `video-${index}`,
					generation: "generation",
					attemptId: "attempt",
					sourceBytes: 1024 ** 3,
					now: new Date("2026-09-06T23:59:59Z"),
				}),
			).resolves.toBe(getMediaProcessingReservation(1024 ** 3).attemptBytes);
		}
		expect(state.rows.size).toBe(20);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("reuses an attempt reservation across dispatch retries and midnight", async () => {
	const input = {
		videoId: "video",
		generation: "generation",
		attemptId: "attempt",
		sourceBytes: 1024 ** 3,
	};
	const first = await reserveMediaProcessingBudget({
		...input,
		now: new Date("2026-09-06T23:59:59Z"),
	});
	for (let index = 0; index < 10; index++)
		expect(
			await reserveMediaProcessingBudget({
				...input,
				now: new Date("2026-09-07T00:00:01Z"),
			}),
		).toBe(first);
	expect([...state.rows.values()].map((row) => row.reservedBytes)).toEqual([
		first,
		first,
	]);
});

it("still bounds repeated processing of the same immutable source", async () => {
	const input = {
		videoId: "video",
		generation: "generation",
		sourceBytes: 1024 ** 3,
	};
	for (let index = 0; index < 3; index++)
		await reserveMediaProcessingBudget({
			...input,
			attemptId: `attempt-${index}`,
		});
	await expect(
		reserveMediaProcessingBudget({ ...input, attemptId: "attempt-4" }),
	).rejects.toThrow("recording transfer budget exhausted");
});
