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

const mocks = vi.hoisted(() => ({
	getLoomDownloadUrl: vi.fn(),
	getWritableAccessForUser: vi.fn(),
	LoomDownloadTemporaryError: class extends Error {},
	start: vi.fn(),
}));

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
vi.mock("@cap/database/video-sharing-default", () => ({
	getNewVideoPublic: vi.fn(async () => true),
}));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({}));
vi.mock("@/lib/account-deletion-request", () => ({}));
vi.mock("@/lib/desktop-segments-finalization", () => ({}));
vi.mock("@/lib/loom-concierge", () => ({}));
vi.mock("@/lib/loom-download-url", () => ({
	getLoomDownloadUrl: mocks.getLoomDownloadUrl,
	LoomDownloadTemporaryError: mocks.LoomDownloadTemporaryError,
}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/organization-provisioning", () => ({}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => false),
	RATE_LIMIT_IDS: {},
}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: "importLoomVideoWorkflow",
}));
vi.mock("workflow/api", () => ({ getRun: vi.fn(), start: mocks.start }));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({}) }));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	return {
		Database,
		Storage: Object.assign(Context.GenericTag("mobile-loom-test/Storage"), {
			getWritableAccessForUser: mocks.getWritableAccessForUser,
		}),
		Tinybird: Context.GenericTag("mobile-loom-test/Tinybird"),
		VideosPolicy: Context.GenericTag("mobile-loom-test/VideosPolicy"),
		Videos: Context.GenericTag("mobile-loom-test/Videos"),
		ImageUploads: Context.GenericTag("mobile-loom-test/ImageUploads"),
	};
});

const user = {
	id: User.UserId.make("importer"),
	email: "importer@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("organization"),
	iconUrlOrKey: Option.none(),
};
const loomUrl = "https://www.loom.com/share/0123456789abcdef0123456789abcdef";
type Row = Record<string, unknown>;
let video: Row | null;
let upload: Row | null;

function result(table: MySqlTable) {
	if (table === Db.users) return [{ stripeSubscriptionStatus: "active" }];
	if (table === Db.organizations) return [{ id: user.activeOrganizationId }];
	if (table !== Db.importedVideos) throw new Error("Unexpected table");
	if (!video) return [];
	return [
		{
			importId: video.id,
			videoId: video.id,
			ownerId: video.ownerId,
			bucketId: null,
			metadata: null,
			phase: upload?.phase ?? null,
			rawFileKey: upload?.rawFileKey ?? null,
			uploadUpdatedAt: upload ? new Date(1_000) : null,
		},
	];
}

const database = {
	select: () => ({
		from: (table: MySqlTable) => {
			const query = {
				leftJoin: () => query,
				innerJoin: () => query,
				where: () => Object.assign(Promise.resolve(result(table)), query),
				limit: async () => result(table),
			};
			return query;
		},
	}),
	insert: (table: MySqlTable) => ({
		values: async (row: Row) => {
			if (table === Db.videos) video = row;
			if (table === Db.videoUploads) upload = row;
		},
	}),
	update: (table: MySqlTable) => ({
		set: (values: Row) => ({
			where: async () => {
				if (table === Db.videoUploads && upload) Object.assign(upload, values);
				return [{ affectedRows: 1 }];
			},
		}),
	}),
	transaction: <T>(callback: (tx: unknown) => Promise<T>) => callback(database),
};

let dispose: () => Promise<void>;
vi.mock("@/lib/server", async () => {
	const { Videos, ImageUploads } = await import("@cap/web-backend");
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

function importLoom() {
	return POST(
		new Request("http://localhost/api/mobile/imports/loom", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ loomUrl }),
		}),
	);
}

beforeEach(() => {
	video = null;
	upload = null;
	mocks.start.mockReset().mockResolvedValue(undefined);
	mocks.getWritableAccessForUser.mockReset().mockReturnValue(
		Effect.succeed({
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
		}),
	);
	mocks.getLoomDownloadUrl
		.mockReset()
		.mockResolvedValue("https://cdn.loom.com/sessions/video.mp4");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 404 })),
	);
});

afterAll(async () => {
	vi.unstubAllGlobals();
	await dispose();
});

describe("POST /api/mobile/imports/loom", () => {
	it("starts a new import and returns its share link", async () => {
		const response = await importLoom();

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.id).toBe(video?.id);
		expect(body.shareUrl).toMatch(new RegExp(`/s/${video?.id}$`));
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("recovers when the import workflow could not start", async () => {
		mocks.start.mockRejectedValueOnce(new Error("queue unavailable"));

		const failed = await importLoom();

		expect(failed.status).toBe(500);
		expect(upload).toMatchObject({
			phase: "error",
			processingError: "Loom import could not start. Please try again.",
		});

		const failedVideoId = video?.id;
		const retried = await importLoom();

		expect(retried.status).toBe(200);
		expect((await retried.json()).id).toBe(failedVideoId);
		expect(video?.id).toBe(failedVideoId);
		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(mocks.start.mock.calls[1]?.[1]).toEqual([
			expect.objectContaining({
				videoId: failedVideoId,
				reuseExistingRawUpload: true,
			}),
		]);
	});

	it("reports a failed restart as a server error", async () => {
		mocks.start.mockRejectedValue(new Error("queue unavailable"));

		await importLoom();
		const retried = await importLoom();

		expect(retried.status).toBe(500);
		expect(mocks.start).toHaveBeenCalledTimes(2);
		expect(upload).toMatchObject({
			phase: "error",
			processingError: "Loom import could not start. Please try again.",
		});
	});

	it("reports a storage failure as a server error", async () => {
		mocks.getWritableAccessForUser.mockReturnValue(
			Effect.fail(new Error("storage unavailable")),
		);

		const response = await importLoom();

		expect(response.status).toBe(500);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("reports a Loom outage as a server error", async () => {
		mocks.getLoomDownloadUrl.mockRejectedValue(
			new mocks.LoomDownloadTemporaryError("Loom is unavailable"),
		);

		const response = await importLoom();

		expect(response.status).toBe(500);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("rejects a Loom video it cannot download", async () => {
		mocks.getLoomDownloadUrl.mockResolvedValue(null);

		const response = await importLoom();

		expect(response.status).toBe(400);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("rejects a Loom video that is already in the organization", async () => {
		video = { id: "imported-video", ownerId: user.id };

		const response = await importLoom();

		expect(response.status).toBe(400);
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
