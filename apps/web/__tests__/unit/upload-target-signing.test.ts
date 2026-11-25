import { S3Client } from "@aws-sdk/client-s3";
import { User } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bucketAccessForUser: vi.fn() }));

vi.mock("@cap/web-backend/src/S3Buckets/index.ts", async () => {
	const { Effect } = await import("effect");
	class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
		sync: () => ({ getBucketAccessForUser: mocks.bucketAccessForUser }),
	}) {}
	return { S3Buckets };
});

import { S3Buckets } from "@cap/web-backend/src/S3Buckets";
import { createS3BucketAccess } from "@cap/web-backend/src/S3Buckets/S3BucketAccess";
import { S3BucketClientProvider } from "@cap/web-backend/src/S3Buckets/S3BucketClientProvider";
import { Storage } from "@cap/web-backend/src/Storage";
import { StorageRepo } from "@cap/web-backend/src/Storage/StorageRepo";

async function createPutTarget(input: {
	contentType: string;
	unsignedContentType?: boolean;
}) {
	const client = new S3Client({
		region: "us-east-1",
		endpoint: "http://127.0.0.1:9",
		forcePathStyle: true,
		credentials: { accessKeyId: "key", secretAccessKey: "secret" },
	});
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
	mocks.bucketAccessForUser.mockReturnValue(
		Effect.succeed([access, Option.none()]),
	);
	const repo = {
		getActiveIntegrationForUser: () => Effect.succeed(Option.none()),
	} as unknown as StorageRepo;

	const { upload } = await Effect.runPromise(
		Effect.flatMap(Storage, (storage) =>
			storage.createUploadTargetForUser(
				User.UserId.make("owner"),
				"owner/video/result.mp4",
				{ ...input, method: "put" },
			),
		).pipe(
			Effect.provide(Storage.DefaultWithoutDependencies),
			Effect.provideService(StorageRepo, repo),
			Effect.provide(S3Buckets.Default),
		),
	);
	if (upload.type !== "put") throw new Error("Expected a PUT upload target");
	return upload;
}

describe("PUT upload targets", () => {
	it("signs the Content-Type the target asks the client to send", async () => {
		const upload = await createPutTarget({ contentType: "video/mp4" });

		expect(upload.headers).toEqual({ "Content-Type": "video/mp4" });
		const signedHeaders = new URL(upload.url).searchParams
			.get("X-Amz-SignedHeaders")
			?.split(";");
		expect(signedHeaders).toContain("content-type");
	});

	it("leaves Content-Type unsigned when a route opts out", async () => {
		const upload = await createPutTarget({
			contentType: "video/mp4",
			unsignedContentType: true,
		});

		const signedHeaders = new URL(upload.url).searchParams
			.get("X-Amz-SignedHeaders")
			?.split(";");
		expect(signedHeaders).not.toContain("content-type");
		expect(upload.headers).toEqual({ "Content-Type": "video/mp4" });
	});
});
