import * as Db from "@cap/database/schema";
import type { SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const videoId = "accessible-video";
const commentId = "new-comment";
const mediaKey = `owner/${videoId}/comments/${commentId}/media.webm`;

const mocks = vi.hoisted(() => ({
	notify: vi.fn(async () => undefined),
	state: { parents: [] as Row[], inserted: [] as Row[] },
}));

const dialect = new MySqlDialect();

function matchesParent(condition: SQL, row: Row) {
	const { sql, params } = dialect.sqlToQuery(condition);
	let index = 0;
	return sql
		.replaceAll(/[()]/g, "")
		.split(" and ")
		.every((clause) => {
			const match = /^`comments`\.`([^`]+)` = \?$/.exec(clause);
			if (!match?.[1]) throw new Error(`Unsupported predicate: ${clause}`);
			return row[match[1]] === params[index++];
		});
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: MySqlTable) => ({
				where: (condition: SQL) => ({
					limit: async () => {
						if (table === Db.videos) return [{ id: videoId }];
						if (table !== Db.comments) throw new Error("Unexpected table");
						return mocks.state.parents.filter((row) =>
							matchesParent(condition, row),
						);
					},
				}),
			}),
		}),
		insert: (table: MySqlTable) => ({
			values: async (row: Row) => {
				if (table !== Db.comments) throw new Error("Unexpected insert");
				mocks.state.inserted.push(row);
			},
		}),
	}),
}));
vi.mock("@cap/database/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/helpers")>()),
	nanoId: () => commentId,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "viewer", name: "Viewer" }),
}));
vi.mock("@cap/web-domain", () => ({
	Comment: { CommentId: { make: (id: string) => id } },
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	verifyCommentMediaUploadToken: () => ({
		userId: "viewer",
		videoId,
		commentId,
		kind: "audio",
		key: mediaKey,
		thumbnailKey: null,
		contentType: "audio/webm",
	}),
	VideosRepo: Effect.succeed({
		getById: () =>
			Effect.succeed(Option.some([{ id: videoId, ownerId: "owner" }])),
	}),
	VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{ headObject: () => Effect.succeed({ ContentLength: 2048 }) },
			]),
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/comment-media", () => ({ sanitizeWaveform: () => undefined }));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: mocks.notify }));
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));

import { newComment } from "@/actions/videos/new-comment";
import { newMediaComment } from "@/actions/videos/new-media-comment";

function postText(parentCommentId = "parent") {
	return newComment({
		content: "A reply",
		videoId: videoId as never,
		type: "text",
		authorImage: null,
		parentCommentId: parentCommentId as never,
		timestamp: null,
	});
}

function postMedia(parentCommentId = "parent") {
	return newMediaComment({
		videoId: videoId as never,
		commentId: commentId as never,
		uploadToken: "token",
		kind: "audio",
		durationSeconds: 3,
		parentCommentId: parentCommentId as never,
		timestamp: null,
		authorImage: null,
	});
}

const rejectedParents = [
	{
		name: "belongs to another video",
		parents: [{ id: "parent", videoId: "private-video", type: "text" }],
	},
	{ name: "does not exist", parents: [] },
];

beforeEach(() => {
	mocks.state.parents = [{ id: "parent", videoId, type: "text" }];
	mocks.state.inserted = [];
	mocks.notify.mockClear();
});

describe.each([
	{ action: "newComment", post: postText },
	{ action: "newMediaComment", post: postMedia },
])("$action reply parent authorization", ({ post }) => {
	it.each(rejectedParents)(
		"rejects a parent that $name",
		async ({ parents }) => {
			mocks.state.parents = parents;
			await expect(post()).rejects.toThrow("Comment not found");
			expect(mocks.state.inserted).toEqual([]);
			expect(mocks.notify).not.toHaveBeenCalled();
		},
	);

	it.each(["text", "emoji", "video", "audio"])(
		"preserves replies to a %s comment on the same video",
		async (type) => {
			mocks.state.parents = [{ id: "parent", videoId, type }];
			await expect(post()).resolves.toMatchObject({
				parentCommentId: "parent",
				videoId,
			});
			expect(mocks.state.inserted).toHaveLength(1);
			expect(mocks.notify).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "reply",
					parentCommentId: "parent",
					videoId,
				}),
			);
		},
	);

	it("preserves top-level comments", async () => {
		mocks.state.parents = [];
		await expect(post("")).resolves.toMatchObject({ parentCommentId: "" });
		expect(mocks.state.inserted).toHaveLength(1);
		expect(mocks.notify).toHaveBeenCalledWith(
			expect.objectContaining({ type: "comment" }),
		);
	});
});
