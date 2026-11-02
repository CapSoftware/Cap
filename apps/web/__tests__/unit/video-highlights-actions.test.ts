import * as Db from "@cap/database/schema";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const videoId = "video-1";

const mocks = vi.hoisted(() => ({
	state: {
		user: { id: "viewer", name: "Viewer" } as {
			id: string;
			name: string;
		} | null,
		canView: true,
		video: { id: "video-1", ownerId: "owner", duration: 120 } as Row | null,
		highlight: null as Row | null,
		total: 0,
		inserted: [] as Row[],
		updated: [] as Row[],
		deleted: 0,
	},
}));

function selectResult(table: MySqlTable, joined: boolean): Row[] {
	const { state } = mocks;
	if (table === Db.videos) return state.video ? [state.video] : [];
	if (table === Db.videoHighlights && joined) {
		if (!state.highlight || !state.video) return [];
		return [{ ...state.highlight, ownerId: state.video.ownerId }];
	}
	if (table === Db.videoHighlights) return [{ total: state.total }];
	throw new Error("Unexpected table");
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: MySqlTable) => {
				let joined = false;
				const query = {
					innerJoin: () => {
						joined = true;
						return query;
					},
					where: () => ({
						limit: async () => selectResult(table, joined),
					}),
				};
				return query;
			},
		}),
		insert: (table: MySqlTable) => ({
			values: async (row: Row) => {
				if (table !== Db.videoHighlights) throw new Error("Unexpected insert");
				mocks.state.inserted.push(row);
			},
		}),
		update: (table: MySqlTable) => ({
			set: (values: Row) => ({
				where: async () => {
					if (table !== Db.videoHighlights)
						throw new Error("Unexpected update");
					mocks.state.updated.push(values);
				},
			}),
		}),
		delete: (table: MySqlTable) => ({
			where: async () => {
				if (table !== Db.videoHighlights) throw new Error("Unexpected delete");
				mocks.state.deleted += 1;
			},
		}),
	}),
}));
vi.mock("@cap/database/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/helpers")>()),
	nanoId: () => "highlight-1",
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.state.user,
}));
vi.mock("@cap/web-domain", () => ({
	Policy: {
		withPublicPolicy:
			() =>
			<A, E, R>(effect: Effect.Effect<A, E, R>) =>
				mocks.state.canView ? effect : Effect.fail("denied"),
	},
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));

import {
	createHighlight,
	deleteHighlight,
	renameHighlight,
} from "@/actions/videos/highlights";

beforeEach(() => {
	mocks.state.user = { id: "viewer", name: "Viewer" };
	mocks.state.canView = true;
	mocks.state.video = { id: videoId, ownerId: "owner", duration: 120 };
	mocks.state.highlight = { id: "highlight-1", videoId, authorId: "viewer" };
	mocks.state.total = 0;
	mocks.state.inserted = [];
	mocks.state.updated = [];
	mocks.state.deleted = 0;
});

describe("createHighlight", () => {
	const create = (timestamp: number, label?: string | null) =>
		createHighlight({ videoId: videoId as never, timestamp, label });

	it("stores a normalized highlight for a viewer who can see the video", async () => {
		await expect(create(12.345, "  the   bug ")).resolves.toMatchObject({
			id: "highlight-1",
			videoId,
			authorId: "viewer",
			authorName: "Viewer",
			timestamp: 12.3,
			label: "the bug",
		});
		expect(mocks.state.inserted).toHaveLength(1);
	});

	it("clamps to the video duration", async () => {
		await expect(create(500)).resolves.toMatchObject({ timestamp: 120 });
	});

	it("requires sign-in", async () => {
		mocks.state.user = null;
		await expect(create(1)).rejects.toThrow("User not authenticated");
		expect(mocks.state.inserted).toEqual([]);
	});

	it("rejects videos the viewer cannot see", async () => {
		mocks.state.canView = false;
		await expect(create(1)).rejects.toThrow("Video not found");
		expect(mocks.state.inserted).toEqual([]);
	});

	it("rejects missing videos", async () => {
		mocks.state.video = null;
		await expect(create(1)).rejects.toThrow("Video not found");
	});

	it("rejects invalid timestamps", async () => {
		await expect(create(-3)).rejects.toThrow("Invalid timestamp");
		await expect(create(Number.NaN)).rejects.toThrow("Invalid timestamp");
	});

	it("enforces the per-video limit", async () => {
		mocks.state.total = 500;
		await expect(create(1)).rejects.toThrow("highlight limit");
		expect(mocks.state.inserted).toEqual([]);
	});
});

describe("renameHighlight and deleteHighlight", () => {
	it("lets the author rename and delete", async () => {
		await expect(
			renameHighlight({ highlightId: "highlight-1", label: " New name " }),
		).resolves.toEqual({ id: "highlight-1", label: "New name" });
		expect(mocks.state.updated).toEqual([{ label: "New name" }]);

		await expect(
			deleteHighlight({ highlightId: "highlight-1" }),
		).resolves.toEqual({ success: true });
		expect(mocks.state.deleted).toBe(1);
	});

	it("lets the video owner manage someone else's highlight", async () => {
		mocks.state.user = { id: "owner", name: "Owner" };
		await expect(
			deleteHighlight({ highlightId: "highlight-1" }),
		).resolves.toEqual({ success: true });
	});

	it("clears the label when renamed to blank", async () => {
		await expect(
			renameHighlight({ highlightId: "highlight-1", label: "   " }),
		).resolves.toEqual({ id: "highlight-1", label: null });
	});

	it("refuses other viewers", async () => {
		mocks.state.user = { id: "stranger", name: "Stranger" };
		await expect(
			renameHighlight({ highlightId: "highlight-1", label: "x" }),
		).rejects.toThrow("permission");
		await expect(
			deleteHighlight({ highlightId: "highlight-1" }),
		).rejects.toThrow("permission");
		expect(mocks.state.updated).toEqual([]);
		expect(mocks.state.deleted).toBe(0);
	});

	it("refuses when the highlight does not exist", async () => {
		mocks.state.highlight = null;
		await expect(deleteHighlight({ highlightId: "missing" })).rejects.toThrow(
			"Highlight not found",
		);
	});

	it("refuses an author who has lost access to the video", async () => {
		mocks.state.canView = false;
		await expect(
			deleteHighlight({ highlightId: "highlight-1" }),
		).rejects.toThrow("Video not found");
		expect(mocks.state.deleted).toBe(0);
	});
});
