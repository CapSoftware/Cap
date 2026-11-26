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
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";

const mocks = vi.hoisted(() => ({
	createUploadTarget: vi.fn(),
	createVideo: vi.fn(),
	getWritableAccessForUser: vi.fn(),
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
vi.mock("@/lib/loom-download-url", () => ({}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/organization-provisioning", () => ({}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: vi.fn(async () => false),
	RATE_LIMIT_IDS: {},
}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("workflow/api", () => ({ getRun: vi.fn(), start: vi.fn() }));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({}) }));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	return {
		Database,
		Storage: Object.assign(Context.GenericTag("mobile-upload-test/Storage"), {
			getWritableAccessForUser: mocks.getWritableAccessForUser,
		}),
		Tinybird: Context.GenericTag("mobile-upload-test/Tinybird"),
		VideosPolicy: Context.GenericTag("mobile-upload-test/VideosPolicy"),
		VideosRepo: Context.GenericTag("mobile-upload-test/VideosRepo"),
		Videos: Context.GenericTag("mobile-upload-test/Videos"),
		ImageUploads: Context.GenericTag("mobile-upload-test/ImageUploads"),
	};
});

const user = {
	id: User.UserId.make("uploader"),
	email: "uploader@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("organization"),
	iconUrlOrKey: Option.none(),
};

const database = {
	select: () => ({
		from: (table: MySqlTable) => {
			const rows =
				table === Db.organizations ? [{ id: user.activeOrganizationId }] : [];
			const query = {
				leftJoin: () => query,
				innerJoin: () => query,
				where: () => Object.assign(Promise.resolve(rows), query),
				limit: async () => rows,
			};
			return query;
		},
	}),
	insert: () => ({ values: async () => undefined }),
	update: () => ({
		set: () => ({ where: async () => [{ affectedRows: 1 }] }),
	}),
	transaction: <T>(callback: (tx: unknown) => Promise<T>) => callback(database),
};

let dispose: () => Promise<void>;
vi.mock("@/lib/server", async () => {
	const { Videos, VideosRepo, ImageUploads, Storage } = await import(
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
						Layer.succeed(Storage, {
							getWritableAccessForUser: mocks.getWritableAccessForUser,
						} as never),
					),
					Layer.provide(
						Layer.succeed(VideosRepo, {
							create: mocks.createVideo,
						} as never),
					),
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

function createUpload(fileName: string, contentType: string) {
	return POST(
		new Request("http://localhost/api/mobile/uploads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName, contentType, contentLength: 1024 }),
		}),
	);
}

beforeEach(() => {
	mocks.createVideo
		.mockReset()
		.mockReturnValue(Effect.succeed(Video.VideoId.make("video")));
	mocks.createUploadTarget
		.mockReset()
		.mockImplementation((_key: string, input: { contentType: string }) =>
			Effect.succeed({
				type: "put",
				url: "https://storage.test/upload",
				headers: { "Content-Type": input.contentType },
			}),
		);
	mocks.getWritableAccessForUser.mockReset().mockReturnValue(
		Effect.succeed({
			access: { createUploadTarget: mocks.createUploadTarget },
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
		}),
	);
});

afterAll(async () => {
	await dispose();
});

describe("POST /api/mobile/uploads", () => {
	it.each([
		["Clip.mov", "video/quicktime", "raw-upload.mov"],
		["Clip.mp4", "video/mp4", "raw-upload.mp4"],
		["Screen.png", "image/png", "screen-capture.png"],
		["Photo.jpg", "image/jpeg", "screen-capture.jpg"],
	])(
		"keeps the real type of %s sent as %s",
		async (fileName, contentType, objectName) => {
			const response = await createUpload(fileName, contentType);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.rawFileKey).toMatch(new RegExp(`/${objectName}$`));
			expect(body.upload.headers).toEqual({ "Content-Type": contentType });
			expect(mocks.createUploadTarget).toHaveBeenCalledWith(
				body.rawFileKey,
				expect.objectContaining({
					contentType,
					fields: expect.objectContaining({ "Content-Type": contentType }),
				}),
			);
		},
	);

	it.each([
		["page.html", "text/html"],
		["drawing.svg", "image/svg+xml"],
	])("refuses %s sent as %s", async (fileName, contentType) => {
		const response = await createUpload(fileName, contentType);

		expect(response.status).toBe(400);
		expect(mocks.createUploadTarget).not.toHaveBeenCalled();
	});
});
