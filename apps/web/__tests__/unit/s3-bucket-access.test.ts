import * as S3 from "@aws-sdk/client-s3";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

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
