import { generateKeyPairSync } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import * as S3 from "@aws-sdk/client-s3";
import { S3Bucket } from "@cap/web-domain";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("@cap/database/crypto", () => ({
	decrypt: async (value: string) => value,
}));
vi.mock("@cap/web-backend/src/Database.ts", async () => {
	const { Effect } = await import("effect");
	class Database extends Effect.Service<Database>()("Database", {
		sync: () => ({}),
	}) {}
	return { Database };
});
vi.mock("@cap/web-backend/src/Aws.ts", async () => {
	const { Effect } = await import("effect");
	class AwsCredentials extends Effect.Service<AwsCredentials>()(
		"AwsCredentials",
		{
			sync: () => ({
				credentials: {
					accessKeyId: "default-key",
					secretAccessKey: "test-secret",
				},
			}),
		},
	) {}
	return { AwsCredentials };
});
vi.mock("@cap/web-backend/src/S3Buckets/S3BucketsRepo.ts", async () => {
	const { Effect } = await import("effect");
	class S3BucketsRepo extends Effect.Service<S3BucketsRepo>()("S3BucketsRepo", {
		sync: () => ({ getById: mocks.getById }),
	}) {}
	return { S3BucketsRepo };
});

import { S3Buckets } from "@cap/web-backend/src/S3Buckets";
import { s3ConnectionPool } from "@cap/web-backend/src/S3Buckets/S3ConnectionPool";

async function storageFixture(config: Record<string, string> = {}) {
	let connections = 0;
	const sockets = new Set<Socket>();
	const authorizations: string[] = [];
	const server = createServer((request, response) => {
		authorizations.push(request.headers.authorization ?? "");
		response.writeHead(200, {
			"Content-Length": "1",
			ETag: '"source-identity"',
		});
		response.end();
	});
	server.on("connection", (socket) => {
		connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const endpoint = `http://127.0.0.1:${address.port}`;
	const runtime = ManagedRuntime.make(
		S3Buckets.Default.pipe(
			Layer.provide(
				Layer.setConfigProvider(
					ConfigProvider.fromMap(
						new Map([
							["CAP_AWS_REGION", "us-east-1"],
							["CAP_AWS_BUCKET", "capso"],
							["S3_INTERNAL_ENDPOINT", endpoint],
							["S3_PUBLIC_ENDPOINT", endpoint],
							...Object.entries(config),
						]),
					),
				),
			),
		),
	);
	const service = await runtime.runPromise(S3Buckets);
	return {
		endpoint,
		runtime,
		service,
		authorizations,
		connections: () => connections,
		async close() {
			await runtime.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

describe("S3 connection reuse", () => {
	it("bounds connections across simultaneous recording checkpoints", async () => {
		const fixture = await storageFixture();
		try {
			await Promise.all(
				Array.from({ length: 24 }, async (_, recording) => {
					const [access] = await fixture.runtime.runPromise(
						fixture.service.getBucketAccess(Option.none()),
					);
					await Promise.all(
						Array.from({ length: 8 }, (_, index) =>
							fixture.runtime.runPromise(
								access.headObject(`recording/${recording}/${index}`),
							),
						),
					);
				}),
			);
			expect(fixture.authorizations).toHaveLength(192);
			expect(fixture.connections()).toBeLessThanOrEqual(50);
		} finally {
			await fixture.close();
		}
	});

	it("expires idle connections, clears their timer on reuse, and closes on disposal", async () => {
		const fixture = await storageFixture();
		try {
			const socket = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* s3ConnectionPool;
						return yield* Effect.promise(async () => {
							const send = () =>
								new Promise<{ socket: Socket; timeout: number | undefined }>(
									(resolve, reject) => {
										let acquired: Socket | undefined;
										let timeout: number | undefined;
										const request = httpRequest(fixture.endpoint, {
											method: "HEAD",
											agent: pool.httpAgent,
										});
										request.on("socket", (socket) => {
											acquired = socket;
											timeout = socket.timeout;
										});
										request.on("response", (response) => {
											response.on("end", () => {
												if (acquired) resolve({ socket: acquired, timeout });
												else reject(new Error("Missing connection"));
											});
											response.resume();
										});
										request.on("error", reject);
										request.end();
									},
								);
							const first = await send();
							await new Promise<void>((resolve) => setImmediate(resolve));
							expect(first.socket.timeout).toBeGreaterThan(0);
							expect(first.socket.timeout).toBeLessThanOrEqual(30_000);
							const second = await send();
							expect(second.socket).toBe(first.socket);
							expect(second.timeout).toBe(0);
							return first.socket;
						});
					}),
				),
			);
			expect(socket.destroyed).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it("does not grow connections with every recording checkpoint", async () => {
		const fixture = await storageFixture();
		try {
			for (let checkpoint = 0; checkpoint < 40; checkpoint++) {
				const [access] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(Option.none()),
				);
				await Promise.all(
					Array.from({ length: 8 }, (_, index) =>
						fixture.runtime.runPromise(
							access.headObject(`recording/${checkpoint}/${index}`),
						),
					),
				);
			}
			expect(fixture.authorizations).toHaveLength(320);
			expect(fixture.connections()).toBeLessThanOrEqual(16);
		} finally {
			await fixture.close();
		}
	});

	it("reuses custom bucket connections while using current credentials", async () => {
		const fixture = await storageFixture();
		try {
			for (let revision = 0; revision < 40; revision++) {
				mocks.getById.mockReturnValue(
					Effect.succeed(
						Option.some(
							S3Bucket.decodeSync({
								id: "custom-bucket",
								ownerId: "owner",
								region: "us-east-1",
								endpoint: fixture.endpoint,
								name: "custom-storage",
								accessKeyId: `rotated-key-${revision}`,
								secretAccessKey: "custom-secret",
							}),
						),
					),
				);
				const [access] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(
						Option.some(S3Bucket.S3BucketId.make("custom-bucket")),
					),
				);
				await fixture.runtime.runPromise(access.headObject("fragment.m4s"));
				expect(fixture.authorizations.at(-1)).toContain(
					`Credential=rotated-key-${revision}/`,
				);
			}
			expect(fixture.connections()).toBeLessThanOrEqual(2);
		} finally {
			await fixture.close();
		}
	});
});

const tokyoConfig = {
	bucket: "cap-test-tokyo",
	bucketUrl: "https://tokyo-cdn.cap.test",
	distributionId: "ETOKYO",
};
const regionalConfig = {
	CAP_REGIONAL_UPLOADS_ENABLED: "true",
	CAP_REGIONAL_UPLOAD_BUCKETS: JSON.stringify({
		"ap-northeast-1": tokyoConfig,
	}),
	CAP_CLOUDFRONT_DISTRIBUTION_ID: "EVIRGINIA",
	CAP_AWS_BUCKET_URL: "https://cdn.cap.test",
	CLOUDFRONT_KEYPAIR_ID: "KTEST",
	CLOUDFRONT_KEYPAIR_PRIVATE_KEY: generateKeyPairSync("rsa", {
		modulusLength: 2048,
	})
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString(),
};

describe("regional storage", () => {
	it("selects per upload without I/O and keeps regional reads after routing is disabled", async () => {
		const fixture = await storageFixture(regionalConfig);
		const repoCalls = mocks.getById.mock.calls.length;
		const send = vi.spyOn(S3.S3Client.prototype, "send");
		try {
			for (const [latitude, longitude, expected] of [
				["35.68", "139.69", "cap-tokyo"],
				["40.71", "-74.01", null],
				["35.68", "139.69", "cap-tokyo"],
				[undefined, undefined, null],
				["bad", "139.69", null],
			] as const) {
				expect(
					Option.getOrNull(
						fixture.service.getRegionalUploadBucketId(latitude, longitude),
					),
				).toBe(expected);
			}
			const [regional] = await fixture.runtime.runPromise(
				fixture.service.getBucketAccess(
					Option.some(S3Bucket.S3BucketId.make("cap-tokyo")),
				),
			);
			const key = "owner/video/segments/segment_000001.m4s";
			for (const effect of [
				regional.getPresignedPutUrl(key),
				regional.getInternalSignedObjectUrl(key),
				regional.getInternalPresignedPutUrl(key),
			]) {
				const url = new URL(await fixture.runtime.runPromise(effect));
				expect(url.hostname).toBe(
					"cap-test-tokyo.s3.ap-northeast-1.amazonaws.com",
				);
				expect(url.pathname).toBe(`/${key}`);
				expect(url.searchParams.get("X-Amz-Credential")).toContain(
					"/ap-northeast-1/s3/",
				);
			}
			const playback = new URL(
				await fixture.runtime.runPromise(regional.getSignedObjectUrl(key)),
			);
			expect(playback.origin).toBe(tokyoConfig.bucketUrl);
			expect(playback.searchParams.get("Key-Pair-Id")).toBe("KTEST");
			const [original] = await fixture.runtime.runPromise(
				fixture.service.getBucketAccess(Option.none()),
			);
			expect(
				new URL(
					await fixture.runtime.runPromise(original.getSignedObjectUrl(key)),
				).origin,
			).toBe(regionalConfig.CAP_AWS_BUCKET_URL);
			expect(send).not.toHaveBeenCalled();
			expect(mocks.getById.mock.calls).toHaveLength(repoCalls);
		} finally {
			send.mockRestore();
			await fixture.close();
		}
		const disabled = await storageFixture({
			...regionalConfig,
			CAP_REGIONAL_UPLOADS_ENABLED: "false",
		});
		try {
			expect(
				Option.isNone(
					disabled.service.getRegionalUploadBucketId("35.68", "139.69"),
				),
			).toBe(true);
			const [regional] = await disabled.runtime.runPromise(
				disabled.service.getBucketAccess(
					Option.some(S3Bucket.S3BucketId.make("cap-tokyo")),
				),
			);
			expect(regional.bucketName).toBe("cap-test-tokyo");
		} finally {
			await disabled.close();
		}
	});

	it.each([
		{},
		{ CAP_REGIONAL_UPLOADS_ENABLED: "true" },
		{ ...regionalConfig, CAP_REGIONAL_UPLOADS_ENABLED: "invalid" },
		{ ...regionalConfig, CAP_AWS_REGION: "eu-west-1" },
		...[
			"not json",
			"null",
			"[]",
			JSON.stringify({
				"ap-northeast-1": { ...tokyoConfig, bucket: "INVALID" },
			}),
			JSON.stringify({
				"ap-northeast-1": {
					...tokyoConfig,
					bucketUrl: "http://tokyo-cdn.cap.test",
				},
			}),
			JSON.stringify({
				"ap-northeast-1": {
					...tokyoConfig,
					bucketUrl: "https://tokyo-cdn.cap.test/path",
				},
			}),
			JSON.stringify({
				"ap-northeast-1": { ...tokyoConfig, distributionId: "" },
			}),
		].map((value) => ({
			...regionalConfig,
			CAP_REGIONAL_UPLOAD_BUCKETS: value,
		})),
		Object.fromEntries(
			Object.entries(regionalConfig).filter(
				([key]) => key !== "CLOUDFRONT_KEYPAIR_ID",
			),
		),
	])(
		"keeps the original upload endpoint when routing is unavailable (%#)",
		async (config) => {
			const fixture = await storageFixture({
				...config,
				S3_PUBLIC_ENDPOINT: "https://s3-accelerate.amazonaws.com",
				S3_PATH_STYLE: "false",
			});
			try {
				expect(
					Option.isNone(
						fixture.service.getRegionalUploadBucketId("35.68", "139.69"),
					),
				).toBe(true);
				const [original] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(Option.none()),
				);
				const url = new URL(
					await fixture.runtime.runPromise(
						original.getPresignedPutUrl("owner/video/result.mp4"),
					),
				);
				expect(url.hostname).toBe("capso.s3-accelerate.amazonaws.com");
				expect(url.searchParams.get("X-Amz-Credential")).toContain(
					`/${"CAP_AWS_REGION" in config ? config.CAP_AWS_REGION : "us-east-1"}/s3/`,
				);
			} finally {
				await fixture.close();
			}
		},
	);

	it("fails a persisted regional recording safely instead of writing to Virginia when config is lost", async () => {
		const fixture = await storageFixture();
		const repoCalls = mocks.getById.mock.calls.length;
		try {
			await expect(
				fixture.runtime.runPromise(
					fixture.service.getBucketAccess(
						Option.some(S3Bucket.S3BucketId.make("cap-tokyo")),
					),
				),
			).rejects.toThrow("Regional storage configuration");
			expect(mocks.getById.mock.calls).toHaveLength(repoCalls);
		} finally {
			await fixture.close();
		}
	});

	it.each(S3Bucket.RegionalBuckets)(
		"keeps signing, processing, copying, and cleanup in $region",
		async (region) => {
			const bucket = `${region.id}-test`;
			const fixture = await storageFixture({
				...regionalConfig,
				CAP_REGIONAL_UPLOAD_BUCKETS: JSON.stringify({
					[region.region]: { ...tokyoConfig, bucket },
				}),
			});
			const send = vi
				.spyOn(S3.S3Client.prototype, "send")
				.mockImplementation(async () => ({}));
			try {
				const [regional] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(Option.some(region.id)),
				);
				const upload = new URL(
					await fixture.runtime.runPromise(
						regional.getPresignedPutUrl("owner/video/result.mp4"),
					),
				);
				expect(upload.hostname).toBe(
					`${bucket}.s3.${region.region}.amazonaws.com`,
				);
				expect(upload.searchParams.get("X-Amz-Credential")).toContain(
					`/${region.region}/s3/`,
				);
				await fixture.runtime.runPromise(
					regional.headObject("owner/video/result.mp4"),
				);
				await fixture.runtime.runPromise(
					regional.copyObject(
						`${bucket}/owner/video/result.mp4`,
						"new-owner/video/result.mp4",
					),
				);
				await fixture.runtime.runPromise(
					regional.listObjects({ prefix: "owner/video/" }),
				);
				await fixture.runtime.runPromise(
					regional.deleteObjects([{ Key: "owner/video/result.mp4" }]),
				);
				expect(send).toHaveBeenCalledTimes(4);
				for (const [command] of send.mock.calls)
					expect(command.input).toHaveProperty("Bucket", bucket);
			} finally {
				send.mockRestore();
				await fixture.close();
			}
		},
	);
});
