import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	DatabaseError,
	HttpAuthMiddleware,
	Organisation,
	User,
	Video,
} from "@cap/web-domain";
import { type HttpApi, HttpApiBuilder, HttpServer } from "@effect/platform";
import type { SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";

const mocks = vi.hoisted(() => ({ notify: vi.fn(async () => undefined) }));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/auth-options", () => ({ authOptions: () => ({}) }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@/actions/loom", () => ({ downloadLoomVideo: vi.fn() }));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({
	getOrgAnalyticsData: vi.fn(),
}));
vi.mock("@/lib/account-deletion-request", () => ({}));
vi.mock("@/lib/desktop-segments-finalization", () => ({}));
vi.mock("@/lib/Notification", () => ({
	createNotification: mocks.notify,
	sendFirstViewEmail: vi.fn(),
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoOverShareableLinkLimit: vi.fn(async () => false),
}));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: vi.fn(async () => false),
}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	const { collectPasswordHashes, resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		Database,
		collectPasswordHashes,
		resolveEffectiveVideoRules,
		Tinybird: Context.GenericTag("mobile-comment-test/Tinybird"),
		VideosPolicy: Context.GenericTag("mobile-comment-test/VideosPolicy"),
		Videos: Context.GenericTag("mobile-comment-test/Videos"),
		ImageUploads: Context.GenericTag("mobile-comment-test/ImageUploads"),
	};
});

const user = {
	id: User.UserId.make("viewer"),
	email: "viewer@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("organization"),
	iconUrlOrKey: Option.none(),
};
const videoId = Video.VideoId.make("accessible-video");
type Row = Record<string, unknown>;
let parents: Row[];
let inserted: Row[];
let videoSettings: Row | null;
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

const database = {
	select: (columns?: Record<string, unknown>) => ({
		from: (table: MySqlTable) => {
			let condition: SQL;
			const result = () => {
				if (table === Db.users) return [{ preferences: {} }];
				if (table === Db.organizations)
					return [{ id: user.activeOrganizationId }];
				if (table === Db.videos)
					return [{ ownerId: user.id, settings: videoSettings }];
				if (table === Db.spaceVideos) return [];
				if (table !== Db.comments) throw new Error("Unexpected table");
				if (
					columns &&
					"parentCommentId" in columns &&
					Object.keys(columns).length === 2
				) {
					return parents.filter((row) => matchesParent(condition, row));
				}
				return inserted.map((row) => ({
					...row,
					authorName: "Viewer",
					authorImage: null,
					authorPreferences: {},
				}));
			};
			const query = {
				leftJoin: () => query,
				innerJoin: () => query,
				// Drizzle queries are awaitable without .limit(); mirror that.
				where: (value: SQL) => {
					condition = value;
					return Object.assign(Promise.resolve().then(result), query);
				},
				limit: async () => result(),
				orderBy: async () => result(),
			};
			return query;
		},
	}),
	insert: (table: MySqlTable) => ({
		values: async (row: Row) => {
			if (table !== Db.comments) throw new Error("Unexpected insert");
			inserted.push(row);
		},
	}),
};

let dispose: () => Promise<void>;
vi.mock("@/lib/server", async () => {
	const { Videos, ImageUploads } = await import("@cap/web-backend");
	return {
		apiToHandler: (
			api: Layer.Layer<HttpApi.Api, never, Database | HttpAuthMiddleware>,
		) => {
			const web = HttpApiBuilder.toWebHandler(
				api.pipe(
					Layer.provide(
						Layer.succeed(
							Database,
							Database.make({
								use: (callback) =>
									Effect.tryPromise({
										try: () => callback(database as unknown as DbClient),
										catch: (cause) => new DatabaseError({ cause }),
									}),
							}),
						),
					),
					Layer.provide(Layer.mock(Videos, { _tag: "Videos" })),
					Layer.provide(Layer.mock(ImageUploads, { _tag: "ImageUploads" })),
					Layer.provide(
						Layer.succeed(
							HttpAuthMiddleware,
							Effect.succeed(CurrentUser.of(user)),
						),
					),
					Layer.merge(HttpServer.layerContext),
				),
			);
			dispose = web.dispose;
			return web.handler;
		},
	};
});

const { POST } = await import("@/app/api/mobile/[...route]/route");

function postComment(parentCommentId: string | null = "parent") {
	return POST(
		new Request(`http://localhost/api/mobile/caps/${videoId}/comments`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: " A reply ",
				timestamp: null,
				parentCommentId,
			}),
		}),
	);
}

beforeEach(() => {
	parents = [{ id: "parent", videoId, type: "text", parentCommentId: null }];
	inserted = [];
	videoSettings = null;
	mocks.notify.mockClear();
});

afterAll(async () => {
	await dispose();
});

describe("mobile reply parent authorization", () => {
	it.each([
		{
			name: "belongs to another video",
			candidates: [{ id: "parent", videoId: "private-video", type: "text" }],
		},
		{
			name: "is not a text comment",
			candidates: [{ id: "parent", videoId, type: "emoji" }],
		},
		{ name: "does not exist", candidates: [] },
	])("rejects a parent that $name", async ({ candidates }) => {
		parents = candidates;
		const response = await postComment();
		expect(response.status).toBe(404);
		expect(inserted).toEqual([]);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("preserves replies to text comments on the accessible video", async () => {
		const response = await postComment();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			content: "A reply",
			parentCommentId: "parent",
			videoId,
		});
		expect(inserted).toHaveLength(1);
		expect(mocks.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "reply",
				parentCommentId: "parent",
				videoId,
			}),
		);
	});

	it("threads a reply to a reply under the top-level comment", async () => {
		parents = [
			{ id: "parent", videoId, type: "text", parentCommentId: "root" },
		];
		const response = await postComment();
		expect(response.status).toBe(200);
		expect(inserted[0]).toMatchObject({ parentCommentId: "root" });
	});

	it("rejects comments when the Cap has comments turned off", async () => {
		videoSettings = { disableComments: true };
		const response = await postComment(null);
		expect(response.status).toBe(403);
		expect(inserted).toEqual([]);
	});

	it("preserves top-level comments", async () => {
		const response = await postComment(null);
		expect(response.status).toBe(200);
		expect(inserted).toHaveLength(1);
		expect(mocks.notify).toHaveBeenCalledWith(
			expect.objectContaining({ type: "comment" }),
		);
	});
});
