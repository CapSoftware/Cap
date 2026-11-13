import { randomUUID } from "node:crypto";
import {
	CreateBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { drizzle } from "drizzle-orm/mysql2";
import { Effect, Layer, Option } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Drives the real /initiate handler against a real MySQL database and a real
// S3-compatible bucket. Auth, the video lookup and the plan check are the only
// stubs; the comment throttle, the rate limiter, the quota reservation and the
// bucket listing all run for real.

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	s3: undefined as unknown,
	bucket: "",
	ownerId: "",
	videoId: "",
}));

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: {
			req: { header: (name: string) => string | undefined };
			set: (key: string, value: unknown) => void;
		},
		next: () => Promise<void>,
	) => {
		c.set("user", { id: c.req.header("x-test-user") });
		await next();
	},
}));
vi.mock("@cap/web-domain", () => ({
	Comment: { CommentId: { make: (value: string) => value } },
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
	Video: {
		VideoId: { make: (value: string) => value },
		NotFoundError: class {},
	},
}));
vi.mock("@cap/web-backend", () => {
	const client = () => fixture.s3 as S3Client;
	return {
		createCommentMediaUploadToken: () => "upload-token",
		verifyCommentMediaUploadToken: () => null,
		makeCurrentUserLayer: () => Layer.empty,
		provideOptionalAuth: (effect: unknown) => effect,
		VideosRepo: Effect.succeed({
			getById: () =>
				Effect.succeed(
					Option.some([{ id: fixture.videoId, ownerId: fixture.ownerId }]),
				),
		}),
		VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						provider: "aws",
						listObjects: (input: { prefix: string; maxKeys: number }) =>
							Effect.promise(() =>
								client().send(
									new ListObjectsV2Command({
										Bucket: fixture.bucket,
										Prefix: input.prefix,
										MaxKeys: input.maxKeys,
									}),
								),
							),
						createUploadTarget: (
							key: string,
							options: { contentType: string },
						) =>
							Effect.promise(async () => ({
								url: await getSignedUrl(
									client(),
									new PutObjectCommand({
										Bucket: fixture.bucket,
										Key: key,
										ContentType: options.contentType,
									}),
									{ expiresIn: 600 },
								),
								method: "PUT",
							})),
					},
				]),
		},
	};
});
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

const { app } = await import("@/app/api/upload/[...route]/comment-media");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const s3Endpoint = process.env.CAP_COMMENT_MEDIA_TEST_S3_ENDPOINT;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);

type Initiated = {
	key: string;
	upload: { url: string };
	thumbnailUpload: { url: string } | null;
};

const initiate = (user: string, body: Record<string, unknown> = {}) =>
	app.request("/initiate", {
		method: "POST",
		headers: { "content-type": "application/json", "x-test-user": user },
		body: JSON.stringify({
			videoId: fixture.videoId,
			kind: "video",
			contentType: "video/webm",
			mode: "single",
			withThumbnail: true,
			...body,
		}),
	});

const put = (url: string, contentType: string, bytes: Uint8Array) =>
	fetch(url, {
		method: "PUT",
		headers: { "content-type": contentType },
		body: bytes,
	});

const storedCount = async () => {
	const listed = await (fixture.s3 as S3Client).send(
		new ListObjectsV2Command({
			Bucket: fixture.bucket,
			Prefix: `${fixture.ownerId}/${fixture.videoId}/comments/`,
		}),
	);
	return listed.KeyCount ?? 0;
};

const freshVideo = () => {
	fixture.ownerId = `owner-${id()}`;
	fixture.videoId = `video-${id()}`;
};

describe.runIf(Boolean(databaseUrl && s3Endpoint))(
	"comment media initiate against a real database and bucket",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			if (!databaseUrl || !s3Endpoint)
				throw new Error("Missing isolated test database or bucket.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			)
				throw new Error("These tests require a session-scoped local database.");
			if (!["127.0.0.1", "localhost"].includes(new URL(s3Endpoint).hostname))
				throw new Error("These tests require a local bucket.");
			pool = createPool({ uri: databaseUrl, connectionLimit: 16 });
			fixture.database = drizzle(pool);
			fixture.s3 = new S3Client({
				endpoint: s3Endpoint,
				region: "us-east-1",
				forcePathStyle: true,
				credentials: {
					accessKeyId: process.env.CAP_COMMENT_MEDIA_TEST_S3_KEY ?? "",
					secretAccessKey: process.env.CAP_COMMENT_MEDIA_TEST_S3_SECRET ?? "",
				},
			});
			fixture.bucket = `comment-media-test-${id()}`;
			await (fixture.s3 as S3Client).send(
				new CreateBucketCommand({ Bucket: fixture.bucket }),
			);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("uploads a normal video, thumbnail and audio comment end to end", async () => {
			freshVideo();
			const user = `viewer-${id()}`;

			const video = await initiate(user);
			expect(video.status).toBe(200);
			const videoBody = (await video.json()) as Initiated;
			expect(videoBody.thumbnailUpload).not.toBeNull();
			expect(
				(await put(videoBody.upload.url, "video/webm", new Uint8Array(4096)))
					.status,
			).toBe(200);
			expect(
				(
					await put(
						videoBody.thumbnailUpload?.url ?? "",
						"image/jpeg",
						new Uint8Array(512),
					)
				).status,
			).toBe(200);

			const audio = await initiate(user, {
				kind: "audio",
				contentType: "audio/webm",
				withThumbnail: false,
			});
			expect(audio.status).toBe(200);
			const audioBody = (await audio.json()) as Initiated;
			expect(audioBody.thumbnailUpload).toBeNull();
			expect(
				(await put(audioBody.upload.url, "audio/webm", new Uint8Array(2048)))
					.status,
			).toBe(200);

			const head = await (fixture.s3 as S3Client).send(
				new HeadObjectCommand({ Bucket: fixture.bucket, Key: videoBody.key }),
			);
			expect(head.ContentLength).toBe(4096);
			expect(await storedCount()).toBe(3);
		});

		it("never refuses a viewer well below the quota", async () => {
			freshVideo();
			const user = `viewer-${id()}`;
			for (let index = 0; index < 30; index++) {
				const response = await initiate(user);
				expect(response.status).toBe(200);
				const body = (await response.json()) as Initiated;
				expect(
					(await put(body.upload.url, "video/webm", new Uint8Array(64))).status,
				).toBe(200);
			}
			expect(await storedCount()).toBe(30);
		});

		it("lets exactly one of many concurrent uploads take the last slots", async () => {
			freshVideo();
			const prefix = `${fixture.ownerId}/${fixture.videoId}/comments`;
			// 398 objects already stored: room for one video plus its thumbnail.
			for (let batch = 0; batch < 398; batch += 50)
				await Promise.all(
					Array.from({ length: Math.min(50, 398 - batch) }, (_, offset) =>
						(fixture.s3 as S3Client).send(
							new PutObjectCommand({
								Bucket: fixture.bucket,
								Key: `${prefix}/seed-${batch + offset}/media.webm`,
								Body: new Uint8Array(1),
							}),
						),
					),
				);
			expect(await storedCount()).toBe(398);

			const responses = await Promise.all(
				Array.from({ length: 8 }, () => initiate(`viewer-${id()}`)),
			);
			const statuses = responses.map((response) => response.status).sort();
			expect(statuses).toEqual([200, 429, 429, 429, 429, 429, 429, 429]);
			for (const response of responses)
				if (response.status === 429)
					expect(await response.json()).toEqual({
						error: "This video has reached its media comment limit",
					});
		});
	},
);
