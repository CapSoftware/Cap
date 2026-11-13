import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	COMMENT_MEDIA_RESERVATION_WINDOW_MS,
	MAX_MEDIA_OBJECTS_PER_VIDEO,
	reserveCommentMediaObjects,
} from "@/lib/comment-media-quota";

type Row = {
	id: string;
	limitBytes: number;
	reservedBytes: number;
	expiresAt: Date;
};

const state = vi.hoisted(() => ({
	rows: new Map<string, Row>(),
	locks: new Map<string, Promise<void>>(),
	lockRows: true,
}));

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

vi.mock("@cap/database/schema", () => ({
	mediaProcessingBudgets: { id: "id", reservedBytes: "reservedBytes" },
}));
vi.mock("drizzle-orm", () => ({
	asc: (value: unknown) => value,
	inArray: (_column: unknown, ids: string[]) => ids,
	sql: (_strings: TemplateStringsArray, ...values: unknown[]) => values,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: async (run: (tx: unknown) => Promise<boolean>) => {
			const releases: (() => void)[] = [];
			const acquire = async (id: string) => {
				const previous = state.locks.get(id) ?? Promise.resolve();
				let release = () => {};
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				state.locks.set(
					id,
					previous.then(() => held),
				);
				await previous;
				releases.push(release);
			};
			try {
				return await run({
					insert: () => ({
						values: (rows: Omit<Row, "reservedBytes">[]) => ({
							onDuplicateKeyUpdate: async () => {
								await pause();
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
									for: async () => {
										if (state.lockRows) for (const id of ids) await acquire(id);
										await pause();
										return ids
											.map((id) => state.rows.get(id))
											.filter(Boolean)
											.map((row) => ({ ...(row as Row) }));
									},
								}),
							}),
						}),
					}),
					update: () => ({
						set: (values: { reservedBytes: [unknown, number] }) => ({
							where: async (ids: string[]) => {
								await pause();
								for (const id of ids) {
									const row = state.rows.get(id);
									if (row) row.reservedBytes += values.reservedBytes[1];
								}
							},
						}),
					}),
				});
			} finally {
				for (const release of releases) release();
			}
		},
	}),
}));

const now = new Date(COMMENT_MEDIA_RESERVATION_WINDOW_MS * 1000 + 60_000);

const reserve = (
	input: Partial<Parameters<typeof reserveCommentMediaObjects>[0]> = {},
) =>
	reserveCommentMediaObjects({
		videoId: "video-1",
		objects: 1,
		storedObjects: 0,
		now,
		...input,
	});

beforeEach(() => {
	state.rows.clear();
	state.locks.clear();
	state.lockRows = true;
});

describe("comment media object quota", () => {
	it("lets a normal upload through on a video with room", async () => {
		await expect(reserve()).resolves.toBe(true);
		await expect(reserve({ objects: 2, storedObjects: 3 })).resolves.toBe(true);
	});

	it("refuses an upload that would pass the per-video cap", async () => {
		await expect(
			reserve({ storedObjects: MAX_MEDIA_OBJECTS_PER_VIDEO }),
		).resolves.toBe(false);
		await expect(
			reserve({ objects: 2, storedObjects: MAX_MEDIA_OBJECTS_PER_VIDEO - 1 }),
		).resolves.toBe(false);
		await expect(
			reserve({ storedObjects: MAX_MEDIA_OBJECTS_PER_VIDEO - 1 }),
		).resolves.toBe(true);
		await expect(
			reserve({ storedObjects: MAX_MEDIA_OBJECTS_PER_VIDEO - 1 }),
		).resolves.toBe(false);
	});

	it("never issues more than the cap to concurrent initiates", async () => {
		const results = await Promise.all(
			Array.from({ length: 500 }, () => reserve()),
		);
		expect(results.filter(Boolean)).toHaveLength(MAX_MEDIA_OBJECTS_PER_VIDEO);
	});

	it("counts thumbnails against the cap under concurrency", async () => {
		const results = await Promise.all(
			Array.from({ length: 300 }, () => reserve({ objects: 2 })),
		);
		expect(results.filter(Boolean)).toHaveLength(
			MAX_MEDIA_OBJECTS_PER_VIDEO / 2,
		);
	});

	it("needs the row lock to hold the cap", async () => {
		state.lockRows = false;
		const results = await Promise.all(
			Array.from({ length: 500 }, () => reserve()),
		);
		expect(results.filter(Boolean).length).toBeGreaterThan(
			MAX_MEDIA_OBJECTS_PER_VIDEO,
		);
	});

	it("keeps counting uploads that can still land and frees them after", async () => {
		await Promise.all(
			Array.from({ length: MAX_MEDIA_OBJECTS_PER_VIDEO }, () => reserve()),
		);
		await expect(reserve()).resolves.toBe(false);

		const nextWindow = new Date(
			now.getTime() + COMMENT_MEDIA_RESERVATION_WINDOW_MS,
		);
		await expect(reserve({ now: nextWindow })).resolves.toBe(false);

		const afterTokensExpire = new Date(
			now.getTime() + 2 * COMMENT_MEDIA_RESERVATION_WINDOW_MS,
		);
		await expect(reserve({ now: afterTokensExpire })).resolves.toBe(true);
	});

	it("keeps each video's reservations separate", async () => {
		await Promise.all(
			Array.from({ length: MAX_MEDIA_OBJECTS_PER_VIDEO }, () => reserve()),
		);
		await expect(reserve({ videoId: "video-2" })).resolves.toBe(true);
	});
});
