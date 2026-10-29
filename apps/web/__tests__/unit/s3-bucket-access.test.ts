import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as S3 from "@aws-sdk/client-s3";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	createS3BucketAccess,
	getRequestAccessibleS3Endpoint,
} from "../../../../packages/web-backend/src/S3Buckets/S3BucketAccess";
import { S3BucketClientProvider } from "../../../../packages/web-backend/src/S3Buckets/S3BucketClientProvider";

describe("getRequestAccessibleS3Endpoint", () => {
	it("replaces a loopback endpoint host for a private network request", () => {
		expect(
			getRequestAccessibleS3Endpoint(
				"http://localhost:9000",
				"http://10.0.0.42:3000/api/mobile/caps",
			),
		).toBe("http://10.0.0.42:9000");
	});

	it("keeps loopback endpoints unchanged for loopback requests", () => {
		expect(
			getRequestAccessibleS3Endpoint(
				"http://localhost:9000",
				"http://localhost:3000/api/mobile/caps",
			),
		).toBeNull();
	});

	it("does not rewrite remote storage endpoints", () => {
		expect(
			getRequestAccessibleS3Endpoint(
				"https://storage.example.com",
				"http://10.0.0.42:3000/api/mobile/caps",
			),
		).toBeNull();
	});

	it("does not rewrite loopback storage for a public request host", () => {
		expect(
			getRequestAccessibleS3Endpoint(
				"http://localhost:9000",
				"https://cap.example.com/api/mobile/caps",
			),
		).toBeNull();
	});

	it("signs public object URLs for the request-accessible endpoint", async () => {
		const client = new S3.S3Client({
			credentials: {
				accessKeyId: "test-access-key",
				secretAccessKey: "test-secret-key",
			},
			endpoint: "http://localhost:9000",
			forcePathStyle: true,
			region: "us-east-1",
		});

		try {
			const access = await Effect.runPromise(
				createS3BucketAccess.pipe(
					Effect.provideService(S3BucketClientProvider, {
						bucket: "capso",
						getInternal: Effect.succeed(client),
						getPublic: Effect.succeed(client),
						isPathStyle: true,
					}),
				),
			);
			const request = HttpServerRequest.fromWeb(
				new Request("http://10.0.0.42:3000/api/mobile/caps"),
			);
			const signedUrl = await Effect.runPromise(
				access
					.getSignedObjectUrl("video/video.mp4")
					.pipe(
						Effect.provideService(HttpServerRequest.HttpServerRequest, request),
					),
			);

			expect(new URL(signedUrl)).toMatchObject({
				hostname: "10.0.0.42",
				port: "9000",
			});
			expect(signedUrl).toContain("X-Amz-Signature=");
		} finally {
			client.destroy();
		}
	});
});

type StorageResponse = { status: number; body: string };

const notImplemented = (header?: string): StorageResponse => ({
	status: 501,
	body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>A header you provided implies functionality that is not implemented</Message>${header ? `<Header>${header}</Header>` : ""}<RequestId>test</RequestId></Error>`,
});

const preconditionFailed: StorageResponse = {
	status: 412,
	body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message><Condition>If-None-Match</Condition><RequestId>test</RequestId></Error>`,
};

const internalError: StorageResponse = {
	status: 500,
	body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error</Message><RequestId>test</RequestId></Error>`,
};

const copied: StorageResponse = {
	status: 200,
	body: `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"copied"</ETag><LastModified>2026-10-29T00:00:00.000Z</LastModified></CopyObjectResult>`,
};

const completed: StorageResponse = {
	status: 200,
	body: `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>http://storage/capso/key</Location><Bucket>capso</Bucket><Key>key</Key><ETag>"completed-2"</ETag></CompleteMultipartUploadResult>`,
};

const retry = { retryWithoutUnsupportedIfNoneMatch: true };
const copyKey = "copies/1/uuid/video/1.m4s";
const outputKey = "outputs/attempt/result.mp4";
const parts = { Parts: [{ PartNumber: 1, ETag: '"part-1"' }] };

type RecordedRequest = {
	method?: string;
	url?: string;
	ifNoneMatch?: string;
	copySourceIfMatch?: string;
};

describe("conditional writes on storage without If-None-Match support", () => {
	let server: Server | undefined;
	let client: S3.S3Client | undefined;

	afterEach(async () => {
		client?.destroy();
		client = undefined;
		await new Promise<void>((resolve) =>
			server ? server.close(() => resolve()) : resolve(),
		);
		server = undefined;
	});

	const storage = async (
		respond: (request: IncomingMessage) => StorageResponse,
	) => {
		const requests: RecordedRequest[] = [];
		const listening = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				requests.push({
					method: request.method,
					url: request.url,
					ifNoneMatch: request.headers["if-none-match"] as string | undefined,
					copySourceIfMatch: request.headers["x-amz-copy-source-if-match"] as
						| string
						| undefined,
				});
				const { status, body } = respond(request);
				response.writeHead(status, { "Content-Type": "application/xml" });
				response.end(body);
			});
		});
		server = listening;
		await new Promise<void>((resolve) =>
			listening.listen(0, "127.0.0.1", resolve),
		);
		const { port } = listening.address() as AddressInfo;
		const s3 = new S3.S3Client({
			credentials: {
				accessKeyId: "test-access-key",
				secretAccessKey: "test-secret-key",
			},
			endpoint: `http://127.0.0.1:${port}`,
			forcePathStyle: true,
			region: "us-east-1",
		});
		client = s3;
		const access = await Effect.runPromise(
			createS3BucketAccess.pipe(
				Effect.provideService(S3BucketClientProvider, {
					bucket: "capso",
					getInternal: Effect.succeed(s3),
					getPublic: Effect.succeed(s3),
					isPathStyle: true,
				}),
			),
		);
		return { access, requests };
	};

	const rejectsConditional =
		(header: string | undefined, success: StorageResponse) =>
		(request: IncomingMessage) =>
			request.headers["if-none-match"] ? notImplemented(header) : success;

	it("retries an opted-in copy once without If-None-Match and keeps its other conditions", async () => {
		const { access, requests } = await storage(
			rejectsConditional("If-None-Match", copied),
		);

		const result = await Effect.runPromise(
			access.copyObject(
				"capso/source.m4s",
				copyKey,
				{
					CopySourceIfMatch: '"source"',
					IfNoneMatch: "*",
					MetadataDirective: "REPLACE",
				},
				retry,
			),
		);

		expect(result.CopyObjectResult?.ETag).toBe('"copied"');
		expect(requests).toEqual([
			expect.objectContaining({
				method: "PUT",
				ifNoneMatch: "*",
				copySourceIfMatch: '"source"',
			}),
			expect.objectContaining({
				method: "PUT",
				ifNoneMatch: undefined,
				copySourceIfMatch: '"source"',
			}),
		]);
		expect(requests[1]?.url).toBe(requests[0]?.url);
	});

	it("retries an opted-in multipart completion once without If-None-Match", async () => {
		const { access, requests } = await storage(
			rejectsConditional("If-None-Match", completed),
		);

		const result = await Effect.runPromise(
			access.multipart.complete(
				outputKey,
				"upload-1",
				{ MultipartUpload: parts, IfNoneMatch: "*" },
				retry,
			),
		);

		expect(result.ETag).toBe('"completed-2"');
		expect(requests.map((request) => request.ifNoneMatch)).toEqual([
			"*",
			undefined,
		]);
		expect(requests.every((request) => request.method === "POST")).toBe(true);
		expect(requests[1]?.url).toBe(requests[0]?.url);
	});

	it("retries when the provider does not name the unsupported header", async () => {
		const { access, requests } = await storage(
			rejectsConditional(undefined, copied),
		);

		await Effect.runPromise(
			access.copyObject(
				"capso/source.m4s",
				copyKey,
				{ IfNoneMatch: "*" },
				retry,
			),
		);

		expect(requests.map((request) => request.ifNoneMatch)).toEqual([
			"*",
			undefined,
		]);
	});

	it("keeps If-None-Match strict for callers that did not opt in", async () => {
		const { access, requests } = await storage(
			rejectsConditional("If-None-Match", completed),
		);

		const copy = await Effect.runPromiseExit(
			access.copyObject("capso/source.m4s", copyKey, { IfNoneMatch: "*" }),
		);
		const complete = await Effect.runPromiseExit(
			access.multipart.complete(
				outputKey,
				"upload-1",
				{ MultipartUpload: parts, IfNoneMatch: "*" },
				{ retryWithoutUnsupportedIfNoneMatch: false },
			),
		);

		expect(Exit.isFailure(copy)).toBe(true);
		expect(Exit.isFailure(complete)).toBe(true);
		expect(requests.map((request) => request.ifNoneMatch)).toEqual(["*", "*"]);
	});

	it.each([
		["an existing object", preconditionFailed],
		[
			"a different unsupported header",
			notImplemented("x-amz-copy-source-if-match"),
		],
		["a server error", internalError],
	])("keeps If-None-Match and fails on %s", async (_name, response) => {
		const { access, requests } = await storage(() => response);

		const exit = await Effect.runPromiseExit(
			access.copyObject(
				"capso/source.m4s",
				copyKey,
				{ IfNoneMatch: "*" },
				retry,
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((request) => request.ifNoneMatch === "*")).toBe(true);
	});

	it("does not retry writes that never asked for If-None-Match", async () => {
		const { access, requests } = await storage(() =>
			notImplemented("If-None-Match"),
		);

		const exit = await Effect.runPromiseExit(
			access.copyObject("capso/source.m4s", copyKey, undefined, retry),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(requests).toHaveLength(1);
	});

	it("surfaces the second failure when the unconditional retry also fails", async () => {
		const { access, requests } = await storage(() =>
			notImplemented("If-None-Match"),
		);

		const exit = await Effect.runPromiseExit(
			access.multipart.complete(
				outputKey,
				"upload-1",
				{ MultipartUpload: parts, IfNoneMatch: "*" },
				retry,
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(requests.map((request) => request.ifNoneMatch)).toEqual([
			"*",
			undefined,
		]);
	});
});
