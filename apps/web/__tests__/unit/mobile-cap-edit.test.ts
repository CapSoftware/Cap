import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	DatabaseError,
	HttpAuthMiddleware,
	Organisation,
	User,
} from "@cap/web-domain";
import { type HttpApi, HttpApiBuilder, HttpServer } from "@effect/platform";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";

const mocks = vi.hoisted(() => {
	class VideoEditError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	}
	return {
		VideoEditError,
		save: vi.fn(),
		restore: vi.fn(),
	};
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	NODE_ENV: "test",
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@cap/database/auth/auth-options", () => ({ authOptions: () => ({}) }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({}));
vi.mock("@/lib/account-deletion-request", () => ({}));
vi.mock("@/lib/desktop-segments-finalization", () => ({}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/organization-provisioning", () => ({}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("workflow/api", () => ({ getRun: vi.fn(), start: vi.fn() }));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({}) }));
vi.mock("@/lib/video-edit-save", () => ({
	VideoEditError: mocks.VideoEditError,
	saveVideoEditsAsUser: mocks.save,
	restoreVideoToOriginalAsUser: mocks.restore,
}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	return {
		Database,
		Storage: Context.GenericTag("mobile-edit-test/Storage"),
		Tinybird: Context.GenericTag("mobile-edit-test/Tinybird"),
		VideosPolicy: Context.GenericTag("mobile-edit-test/VideosPolicy"),
		Videos: Context.GenericTag("mobile-edit-test/Videos"),
		ImageUploads: Context.GenericTag("mobile-edit-test/ImageUploads"),
	};
});

const owner = {
	id: User.UserId.make("owner"),
	email: "owner@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("organization"),
	iconUrlOrKey: Option.none(),
};
let currentUser = owner;
let video: Record<string, unknown>;
let editSpec: unknown;
let pro: boolean;

function rows(table: MySqlTable): unknown[] {
	if (table === Db.users)
		return [
			{
				id: currentUser.id,
				stripeSubscriptionStatus: pro ? "active" : null,
				thirdPartyStripeSubscriptionId: null,
			},
		];
	if (table === Db.organizations)
		return [{ id: owner.activeOrganizationId, ownerId: owner.id }];
	if (table === Db.videos) return [video];
	if (table === Db.videoEdits) return editSpec ? [{ editSpec }] : [];
	return [];
}

const database = {
	select: () => ({
		from: (table: MySqlTable) => {
			const query = {
				leftJoin: () => query,
				innerJoin: () => query,
				where: () => Object.assign(Promise.resolve(rows(table)), query),
				limit: async () => rows(table),
			};
			return query;
		},
	}),
};

let dispose: () => Promise<void>;
vi.mock("@/lib/server", async () => {
	const { Videos, ImageUploads, VideosPolicy } = await import(
		"@cap/web-backend"
	);
	return {
		runPromise: Effect.runPromise,
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
					Layer.provide(
						Layer.succeed(VideosPolicy, {
							canView: () => Effect.succeed("granted"),
						} as never),
					),
					Layer.provide(Layer.mock(ImageUploads, { _tag: "ImageUploads" })),
					Layer.provide(
						Layer.succeed(
							HttpAuthMiddleware,
							Effect.sync(() => CurrentUser.of(currentUser)),
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

const { GET, POST } = await import("@/app/api/mobile/[...route]/route");

const getState = () =>
	GET(new Request("http://localhost/api/mobile/caps/video/edit"));
const save = (body: unknown) =>
	POST(
		new Request("http://localhost/api/mobile/caps/video/edit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
const restore = () =>
	POST(
		new Request("http://localhost/api/mobile/caps/video/edit/restore", {
			method: "POST",
		}),
	);

beforeEach(() => {
	currentUser = owner;
	pro = true;
	editSpec = undefined;
	video = {
		id: "video",
		ownerId: owner.id,
		orgId: owner.activeOrganizationId,
		public: true,
		password: null,
		duration: 60,
		source: { type: "desktopMP4" },
		isScreenshot: false,
		metadata: {},
		uploadPhase: null,
		settings: null,
	};
	mocks.save.mockReset().mockResolvedValue({ success: true });
	mocks.restore.mockReset().mockResolvedValue({ success: true });
});

afterAll(async () => {
	await dispose();
});

describe("GET /api/mobile/caps/:id/edit", () => {
	it("lets a Pro owner edit a processed video", async () => {
		const response = await getState();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "available",
			duration: 60,
			hasEdits: false,
		});
	});

	it("reports existing edits", async () => {
		editSpec = {
			version: 1,
			sourceDuration: 60,
			keepRanges: [{ start: 5, end: 60 }],
		};
		const body = await (await getState()).json();
		expect(body.hasEdits).toBe(true);
	});

	it("asks for Cap Pro before anything else is checked", async () => {
		pro = false;
		expect((await (await getState()).json()).status).toBe("pro_required");
	});

	it("marks screenshots and unprocessed videos as not editable", async () => {
		video.isScreenshot = true;
		expect((await (await getState()).json()).status).toBe("not_editable");
		video.isScreenshot = false;
		video.source = { type: "desktopSegments" };
		expect((await (await getState()).json()).status).toBe("not_editable");
	});

	it("reports an edit or upload in progress as busy", async () => {
		video.uploadPhase = "processing";
		expect((await (await getState()).json()).status).toBe("busy");
		video.uploadPhase = null;
		video.metadata = { editProcessing: { token: "t" } };
		expect((await (await getState()).json()).status).toBe("busy");
	});

	it("hides other people's videos", async () => {
		video.ownerId = "someone-else";
		const response = await getState();
		expect(response.status).toBe(404);
	});
});

describe("POST /api/mobile/caps/:id/edit", () => {
	it("passes the keep ranges to the shared edit save as the owner", async () => {
		const response = await save({
			sourceDuration: 60,
			keepRanges: [
				{ start: 0, end: 10 },
				{ start: 20, end: 60 },
			],
		});
		expect(response.status).toBe(200);
		expect(mocks.save).toHaveBeenCalledWith(
			expect.objectContaining({ id: owner.id }),
			"video",
			{
				version: 1,
				sourceDuration: 60,
				keepRanges: [
					{ start: 0, end: 10 },
					{ start: 20, end: 60 },
				],
			},
		);
	});

	it("rejects an empty edit before it reaches the save", async () => {
		const response = await save({ sourceDuration: 60, keepRanges: [] });
		expect(response.status).toBe(400);
		expect(mocks.save).not.toHaveBeenCalled();
	});

	it.each([
		["pro_required", 403],
		["not_found", 404],
		["busy", 409],
		["invalid", 400],
		["not_editable", 400],
	])("maps %s to %i", async (code, status) => {
		mocks.save.mockRejectedValueOnce(new mocks.VideoEditError(code, code));
		const response = await save({
			sourceDuration: 60,
			keepRanges: [{ start: 0, end: 30 }],
		});
		expect(response.status).toBe(status);
	});

	it("never saves someone else's video", async () => {
		video.ownerId = "someone-else";
		const response = await save({
			sourceDuration: 60,
			keepRanges: [{ start: 0, end: 30 }],
		});
		expect(response.status).toBe(404);
		expect(mocks.save).not.toHaveBeenCalled();
	});
});

describe("POST /api/mobile/caps/:id/edit/restore", () => {
	it("restores the original as the owner", async () => {
		const response = await restore();
		expect(response.status).toBe(200);
		expect(mocks.restore).toHaveBeenCalledWith(
			expect.objectContaining({ id: owner.id }),
			"video",
		);
	});
});
