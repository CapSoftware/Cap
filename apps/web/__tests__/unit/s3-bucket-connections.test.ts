import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
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

async function storageFixture() {
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
