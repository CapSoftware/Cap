import * as Db from "@cap/database/schema";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const videoId = "accessible-video";
const organizationId = "organization";

const mocks = vi.hoisted(() => ({
	notify: vi.fn(async () => undefined),
	state: {
		videoSettings: null as Row | null,
		organizationSettings: null as Row | null,
		spaces: [] as Row[],
		inserted: [] as Row[],
	},
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: MySqlTable) => {
				const rows = () =>
					table === Db.spaceVideos
						? mocks.state.spaces
						: [
								{
									id: videoId,
									videoSettings: mocks.state.videoSettings,
									organizationSettings: mocks.state.organizationSettings,
								},
							];
				const query = {
					leftJoin: () => query,
					innerJoin: () => query,
					where: () => query,
					limit: async () => rows(),
					// biome-ignore lint/suspicious/noThenProperty: Drizzle queries are awaitable without .limit()
					then: (resolve: (value: Row[]) => unknown) => resolve(rows()),
				};
				return query;
			},
		}),
		insert: () => ({
			values: async (row: Row) => {
				mocks.state.inserted.push(row);
			},
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "viewer", name: "Viewer" }),
}));
vi.mock("@cap/web-domain", () => ({
	Comment: { CommentId: { make: (id: string) => id } },
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", async () => {
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		resolveEffectiveVideoRules,
		VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
	};
});
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/comment-reply-parent", () => ({
	isReplyParentOnVideo: async () => true,
}));
vi.mock("@/lib/org-pro", () => ({ isVideoOwnerPro: async () => true }));
vi.mock("@/lib/Notification", () => ({ createNotification: mocks.notify }));
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));

import { newComment } from "@/actions/videos/new-comment";
import { canUseMediaComments } from "@/lib/media-comments";

function post(type: "text" | "emoji", parentCommentId = "") {
	return newComment({
		content: type === "emoji" ? "👍" : "A comment",
		videoId: videoId as never,
		type,
		authorImage: null,
		parentCommentId: parentCommentId as never,
		timestamp: null,
	});
}

const canRecord = () =>
	canUseMediaComments(
		{ id: "viewer" } as never,
		{
			id: videoId,
			ownerId: "owner",
		} as never,
	);

beforeEach(() => {
	mocks.state.videoSettings = null;
	mocks.state.organizationSettings = null;
	mocks.state.spaces = [];
	mocks.state.inserted = [];
	mocks.notify.mockClear();
});

describe("comment and reaction settings", () => {
	it("posts when nothing is disabled", async () => {
		await post("text");
		await post("emoji");
		expect(mocks.state.inserted).toHaveLength(2);
	});

	it("rejects comments and replies when the video disables comments", async () => {
		mocks.state.videoSettings = { disableComments: true };

		await expect(post("text")).rejects.toThrow("disabled");
		await expect(post("text", "parent")).rejects.toThrow("disabled");

		expect(mocks.state.inserted).toEqual([]);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("rejects reactions when the video disables reactions", async () => {
		mocks.state.videoSettings = { disableReactions: true };

		await expect(post("emoji")).rejects.toThrow("disabled");

		expect(mocks.state.inserted).toEqual([]);
	});

	it("keeps comments and reactions independent", async () => {
		mocks.state.videoSettings = { disableComments: true };
		await post("emoji");

		mocks.state.videoSettings = { disableReactions: true };
		await post("text");

		expect(mocks.state.inserted.map((row) => row.type)).toEqual([
			"emoji",
			"text",
		]);
	});

	it("inherits the organization setting unless the video overrides it", async () => {
		mocks.state.organizationSettings = { disableComments: true };
		await expect(post("text")).rejects.toThrow("disabled");

		mocks.state.videoSettings = { disableComments: false };
		await post("text");

		expect(mocks.state.inserted).toHaveLength(1);
	});

	it("applies a space's setting over the video's", async () => {
		mocks.state.videoSettings = { disableComments: false };
		mocks.state.spaces = [
			{
				id: "space",
				name: "Space",
				organizationId,
				settings: { disableComments: true },
			},
		];

		await expect(post("text")).rejects.toThrow("disabled");

		expect(mocks.state.inserted).toEqual([]);
	});

	it("ignores the organization's own all-members space like the share page", async () => {
		mocks.state.spaces = [
			{
				id: organizationId,
				name: "Everyone",
				organizationId,
				settings: { disableComments: true },
			},
		];

		await post("text");

		expect(mocks.state.inserted).toHaveLength(1);
	});

	it("stops media comments when comments are disabled", async () => {
		expect(await canRecord()).toBe(true);

		mocks.state.videoSettings = { disableComments: true };

		expect(await canRecord()).toBe(false);
	});

	it("keeps media comments available when only reactions are disabled", async () => {
		mocks.state.videoSettings = { disableReactions: true };

		expect(await canRecord()).toBe(true);
	});
});
