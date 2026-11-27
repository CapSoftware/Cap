import { generateKeyPairSync } from "node:crypto";
import { S3Bucket } from "@cap/web-domain";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getById: vi.fn(), getForUser: vi.fn() }));

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
		sync: () => ({
			getById: mocks.getById,
			getForUser: mocks.getForUser,
		}),
	}) {}
	return { S3BucketsRepo };
});

import { S3Buckets } from "@cap/web-backend/src/S3Buckets";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const cloudFrontConfig: [string, string][] = [
	["CAP_CLOUDFRONT_DISTRIBUTION_ID", "distribution"],
	["CLOUDFRONT_KEYPAIR_ID", "K2JCJMDEHXQW5F"],
	["CLOUDFRONT_KEYPAIR_PRIVATE_KEY", privateKey],
	["CAP_AWS_BUCKET_URL", "https://cdn.example.com"],
];

const makeRuntime = (extra: [string, string][]) =>
	ManagedRuntime.make(
		S3Buckets.Default.pipe(
			Layer.provide(
				Layer.setConfigProvider(
					ConfigProvider.fromMap(
						new Map([
							["CAP_AWS_REGION", "us-east-1"],
							["CAP_AWS_BUCKET", "capso"],
							["S3_PUBLIC_ENDPOINT", "https://s3.example.com"],
							["S3_INTERNAL_ENDPOINT", "https://s3.example.com"],
							...extra,
						]),
					),
				),
			),
		),
	);

const decodePolicyResource = (signedUrl: string) => {
	const encoded = new URL(signedUrl).searchParams.get("Policy") ?? "";
	const base64 = encoded
		.replace(/-/g, "+")
		.replace(/_/g, "=")
		.replace(/~/g, "/");
	const policy = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
		Statement: { Resource: string }[];
	};
	return policy.Statement[0]?.Resource;
};

const customBucket = S3Bucket.decodeSync({
	id: "custom-bucket",
	ownerId: "owner",
	region: "eu-west-1",
	endpoint: "https://storage.example.org",
	name: "custom-storage",
	accessKeyId: "custom-key",
	secretAccessKey: "custom-secret",
});

let runtime: ReturnType<typeof makeRuntime> | undefined;

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	mocks.getById.mockReset();
});

const downloadUrl = async (
	bucketId: Option.Option<S3Bucket.S3BucketId>,
	fileName: string,
	expiresIn?: number,
) => {
	if (!runtime) throw new Error("runtime not set");
	const service = await runtime.runPromise(S3Buckets);
	const [access] = await runtime.runPromise(service.getBucketAccess(bucketId));
	return new URL(
		await runtime.runPromise(
			access.getSignedDownloadUrl(
				"user/video/result.mp4",
				fileName,
				expiresIn === undefined ? undefined : { expiresIn },
			),
		),
	);
};

describe("S3Buckets.getSignedDownloadUrl", () => {
	it("serves default bucket downloads through CloudFront with the attachment name signed in", async () => {
		runtime = makeRuntime(cloudFrontConfig);
		const url = await downloadUrl(Option.none(), "Démo vidéo (1).mp4");

		expect(url.origin).toBe("https://cdn.example.com");
		expect(url.pathname).toBe("/dl/user/video/result.mp4");
		expect(url.searchParams.get("response-content-disposition")).toBe(
			`attachment; filename="D_mo vid_o (1).mp4"; filename*=UTF-8''D%C3%A9mo%20vid%C3%A9o%20%281%29.mp4`,
		);
		expect(url.searchParams.has("X-Amz-Signature")).toBe(false);
		const signed = url.toString();
		expect(decodePolicyResource(signed)).toBe(
			signed.slice(0, signed.indexOf("&Policy=")),
		);
	});

	it("keeps the requested expiry for CloudFront download URLs", async () => {
		runtime = makeRuntime(cloudFrontConfig);
		const before = Math.floor(Date.now() / 1000);
		const url = await downloadUrl(Option.none(), "clip.mp4", 600);
		const encoded = url.searchParams.get("Policy") ?? "";
		const policy = JSON.parse(
			Buffer.from(
				encoded.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
				"base64",
			).toString("utf8"),
		) as {
			Statement: { Condition: { DateLessThan: { "AWS:EpochTime": number } } }[];
		};
		const expiresAt =
			policy.Statement[0]?.Condition.DateLessThan["AWS:EpochTime"] ?? 0;

		expect(expiresAt).toBeGreaterThanOrEqual(before + 600);
		expect(expiresAt).toBeLessThanOrEqual(before + 602);
	});

	it("keeps S3 presigned downloads for custom buckets when CloudFront is configured", async () => {
		runtime = makeRuntime(cloudFrontConfig);
		mocks.getById.mockReturnValue(Effect.succeed(Option.some(customBucket)));
		const url = await downloadUrl(
			Option.some(S3Bucket.S3BucketId.make("custom-bucket")),
			"clip.mp4",
		);

		expect(url.origin).toBe("https://storage.example.org");
		expect(url.pathname).toBe("/custom-storage/user/video/result.mp4");
		expect(url.searchParams.get("X-Amz-Credential")).toContain("custom-key/");
		expect(url.searchParams.get("response-content-disposition")).toBe(
			`attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
		);
		expect(url.searchParams.has("Key-Pair-Id")).toBe(false);
	});

	it("keeps S3 presigned downloads for the default bucket when CloudFront is not configured", async () => {
		runtime = makeRuntime([]);
		const url = await downloadUrl(Option.none(), "clip.mp4");

		expect(url.origin).toBe("https://s3.example.com");
		expect(url.pathname).toBe("/capso/user/video/result.mp4");
		expect(url.searchParams.get("X-Amz-Credential")).toContain("default-key/");
		expect(url.searchParams.get("response-content-disposition")).toBe(
			`attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
		);
	});

	it("leaves default bucket playback URLs without a disposition", async () => {
		runtime = makeRuntime(cloudFrontConfig);
		const service = await runtime.runPromise(S3Buckets);
		const [access] = await runtime.runPromise(
			service.getBucketAccess(Option.none()),
		);
		const url = new URL(
			await runtime.runPromise(
				access.getSignedObjectUrl("user/video/result.mp4"),
			),
		);

		expect(url.origin).toBe("https://cdn.example.com");
		expect(url.pathname).toBe("/user/video/result.mp4");
		expect(url.searchParams.has("response-content-disposition")).toBe(false);
		expect(decodePolicyResource(url.toString())).toBe(
			"https://cdn.example.com/user/video/result.mp4",
		);
	});
});
