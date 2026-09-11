import { createHash, createHmac } from "node:crypto";
import { S3Bucket, Storage, User, Video } from "@cap/web-domain";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ secret: "" }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: mocks.secret }),
}));

import {
	assertDesktopReuploadTarget,
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	type DesktopReuploadToken,
	type DesktopReuploadVideo,
	decodeDesktopReuploadToken,
	desktopReuploadSourceIdentity,
} from "@/lib/desktop-reupload-token";

const now = Date.UTC(2026, 8, 11);
const lifetime = 30 * 24 * 60 * 60 * 1000;
const canonicalKey = "user/video/result.mp4";
const outputKey =
	"user/video/.recording/outputs/reupload-11111111-1111-4111-8111-111111111111/result.mp4";
const privateUploadUrl =
	"https://www.googleapis.com/upload/drive/v3/files?upload_id=private-upload";
let video: DesktopReuploadVideo;

function createToken(provider: DesktopReuploadToken["provider"] = "s3") {
	return createDesktopReuploadToken(video, {
		provider,
		uploadId: provider === "s3" ? "provider-upload" : privateUploadUrl,
		outputKey,
	});
}

function decodedToken() {
	const token = decodeDesktopReuploadToken(createToken());
	if (!token) throw new Error("Expected a replacement token");
	return token;
}

function signValue(value: unknown, domain = "cap-desktop-reupload:v1:") {
	const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
	const signature = createHmac("sha256", mocks.secret)
		.update(domain)
		.update(payload)
		.digest("base64url");
	return `cap-reupload.${payload}.${signature}`;
}

beforeEach(() => {
	mocks.secret = "test-only-desktop-reupload-signing-key";
	vi.spyOn(Date, "now").mockReturnValue(now);
	video = {
		id: Video.VideoId.make("video"),
		ownerId: User.UserId.make("user"),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		source: {
			type: "desktopMP4",
			outputKey: "user/video/.recording/outputs/previous/result.mp4",
			thumbnailKey: "user/video/thumbnail.jpg",
		},
	};
});

afterEach(() => vi.restoreAllMocks());

describe("desktop reupload tokens", () => {
	it.each(["s3", "googleDrive"] as const)(
		"round trips an opaque %s upload without losing the backend identifier",
		(provider) => {
			const token = decodeDesktopReuploadToken(createToken(provider));
			expect(token).toEqual({
				version: 1,
				ownerId: "user",
				videoId: "video",
				bucketId: null,
				storageIntegrationId: null,
				provider,
				uploadId: provider === "s3" ? "provider-upload" : privateUploadUrl,
				outputKey,
				sourceIdentity: desktopReuploadSourceIdentity(video.source),
				expiresAt: now + lifetime,
			});
		},
	);

	it("uses a new UUID output key for every attempt", () => {
		const first = createDesktopReuploadKey(video);
		const second = createDesktopReuploadKey(video);
		expect(first).not.toBe(second);
		for (const key of [first, second]) {
			expect(key).toMatch(
				/^user\/video\/\.recording\/outputs\/reupload-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/result\.mp4$/,
			);
			expect(
				decodeDesktopReuploadToken(
					createDesktopReuploadToken(video, {
						uploadId: "upload",
						provider: "s3",
						outputKey: key,
					}),
				)?.outputKey,
			).toBe(key);
		}
	});

	it.each(["raw-upload-id", privateUploadUrl, ""])(
		"leaves a legacy backend identifier opaque",
		(raw) => expect(decodeDesktopReuploadToken(raw)).toBeNull(),
	);

	it("rejects modified payloads and signatures instead of falling back to legacy", () => {
		const encoded = createToken();
		const [prefix, payload, signature] = encoded.split(".");
		const changed = Buffer.from(
			JSON.stringify({ ...decodedToken(), videoId: "another-video" }),
		).toString("base64url");
		expect(() =>
			decodeDesktopReuploadToken(`${prefix}.${changed}.${signature}`),
		).toThrow("Invalid desktop reupload token");
		expect(() =>
			decodeDesktopReuploadToken(`${prefix}.${payload}.${"A".repeat(43)}`),
		).toThrow("Invalid desktop reupload token");
	});

	it.each([
		"cap-reupload.",
		"cap-reupload.a.b",
		"cap-reupload.a.b.extra",
		`cap-reupload.${"a".repeat(32_768)}`,
	])("rejects malformed or oversized prefixed tokens", (encoded) => {
		expect(() => decodeDesktopReuploadToken(encoded)).toThrow(
			"Invalid desktop reupload token",
		);
	});

	it("requires the private signing key and the reupload signing domain", () => {
		const token = decodedToken();
		const encoded = createToken("googleDrive");
		expect(() =>
			decodeDesktopReuploadToken(signValue(token, "some-other-token:v1:")),
		).toThrow("Invalid desktop reupload token");
		mocks.secret = "different-test-only-signing-key";
		expect(() => decodeDesktopReuploadToken(encoded)).toThrow(
			"Invalid desktop reupload token",
		);
		mocks.secret = "";
		expect(() => createToken()).toThrow(
			"Desktop reupload signing is unavailable",
		);
	});

	it.each([
		{ version: 2 },
		{ provider: "unknown" },
		{ ownerId: "../user" },
		{ videoId: "video/other" },
		{ bucketId: 1 },
		{ storageIntegrationId: "" },
		{ sourceIdentity: "not-a-hash" },
		{ uploadId: "" },
		{ uploadId: "a".repeat(8193) },
		{ unexpected: "field" },
		{ expiresAt: now },
		{ expiresAt: now - 1 },
		{ expiresAt: now + lifetime + 5 * 60 * 1000 + 1 },
		{ expiresAt: now + 0.5 },
		{ expiresAt: Number.POSITIVE_INFINITY },
	])("validates authenticated token fields: %j", (patch) => {
		expect(() =>
			decodeDesktopReuploadToken(signValue({ ...decodedToken(), ...patch })),
		).toThrow("Invalid desktop reupload token");
	});

	it("accepts a fresh token on a server whose clock is slightly behind", () => {
		const encoded = createToken();
		vi.mocked(Date.now).mockReturnValue(now - 60_000);
		expect(decodeDesktopReuploadToken(encoded)?.outputKey).toBe(outputKey);
	});
	it("expires at the exact lifetime boundary", () => {
		const encoded = createToken();
		vi.mocked(Date.now).mockReturnValue(now + lifetime - 1);
		expect(decodeDesktopReuploadToken(encoded)).not.toBeNull();
		vi.mocked(Date.now).mockReturnValue(now + lifetime);
		expect(() => decodeDesktopReuploadToken(encoded)).toThrow(
			"Invalid desktop reupload token",
		);
	});

	it.each([
		canonicalKey,
		outputKey.replace("user/video/", "other/video/"),
		outputKey.replace("user/video/", "user/other/"),
		outputKey.replace("reupload-", "edit-"),
		outputKey.replace("/result.mp4", "/../result.mp4"),
		outputKey.replace("/result.mp4", "/thumbnail.jpg"),
		outputKey.replace("4111", "1111"),
		`${outputKey}?private=secret`,
	])("rejects an output outside the attempt key namespace", (key) => {
		expect(() =>
			createDesktopReuploadToken(video, {
				uploadId: "upload",
				provider: "s3",
				outputKey: key,
			}),
		).toThrow("Invalid desktop reupload token");
		expect(() =>
			decodeDesktopReuploadToken(
				signValue({ ...decodedToken(), outputKey: key }),
			),
		).toThrow("Invalid desktop reupload token");
	});

	it("does not expose a private backend URL in validation errors", () => {
		const token = decodeDesktopReuploadToken(createToken("googleDrive"));
		let message = "";
		try {
			decodeDesktopReuploadToken(
				signValue({ ...token, outputKey: privateUploadUrl }),
			);
		} catch (error) {
			message = String(error);
		}
		expect(message).toBe("Error: Invalid desktop reupload token");
		expect(message).not.toContain(privateUploadUrl);
		expect(message).not.toContain(mocks.secret);
	});
});

describe("desktop reupload target identity", () => {
	it("matches the Video.source schema with deterministic field order", () => {
		const source = {
			type: "desktopMP4",
			outputKey: "output",
			audioLevelOutputKey: "audio-output",
			audioLevelSourceKey: "audio-source",
			thumbnailKey: "thumbnail",
			previewKey: "preview",
		};
		const expected = createHash("sha256")
			.update(
				JSON.stringify({
					audioLevelOutputKey: "audio-output",
					audioLevelSourceKey: "audio-source",
					outputKey: "output",
					previewKey: "preview",
					thumbnailKey: "thumbnail",
					type: "desktopMP4",
				}),
			)
			.digest("hex");
		expect(desktopReuploadSourceIdentity(source)).toBe(expected);
		expect(
			desktopReuploadSourceIdentity({
				...Object.fromEntries(Object.entries(source).reverse()),
				legacyField: "ignored by Video.source",
			}),
		).toBe(expected);
		expect(
			desktopReuploadSourceIdentity({
				type: "desktopMP4",
				outputKey: undefined,
			}),
		).toBe(desktopReuploadSourceIdentity({ type: "desktopMP4" }));
		for (const key of Object.keys(source)) {
			const changed = {
				...source,
				[key]: key === "type" ? "webMP4" : "changed",
			};
			expect(desktopReuploadSourceIdentity(changed)).not.toBe(expected);
		}
	});

	it("rejects malformed known source fields without echoing them", () => {
		expect(() =>
			desktopReuploadSourceIdentity({ type: "desktopMP4", outputKey: 123 }),
		).toThrow("Invalid recording source");
	});

	it("binds the requested canonical key, owner, and video", () => {
		const token = decodedToken();
		expect(() =>
			assertDesktopReuploadTarget(token, video, canonicalKey, "s3"),
		).not.toThrow();
		for (const key of [
			outputKey,
			"user/video/raw-upload.mp4",
			"other/video/result.mp4",
		]) {
			expect(() => assertDesktopReuploadTarget(token, video, key)).toThrow(
				"Recording target changed",
			);
		}
		expect(() =>
			assertDesktopReuploadTarget(
				token,
				{ ...video, ownerId: User.UserId.make("other") },
				"other/video/result.mp4",
			),
		).toThrow("Recording target changed");
		expect(() =>
			assertDesktopReuploadTarget(
				token,
				{ ...video, id: Video.VideoId.make("other") },
				"user/other/result.mp4",
			),
		).toThrow("Recording target changed");
	});

	it("binds both storage identifiers and the provider", () => {
		const token = decodedToken();
		for (const target of [
			{ ...video, bucketId: Option.some(S3Bucket.S3BucketId.make("bucket")) },
			{
				...video,
				storageIntegrationId: Option.some(
					Storage.StorageIntegrationId.make("integration"),
				),
			},
		]) {
			expect(() =>
				assertDesktopReuploadTarget(token, target, canonicalKey),
			).toThrow("Recording storage changed");
		}
		expect(() =>
			assertDesktopReuploadTarget(token, video, canonicalKey, "googleDrive"),
		).toThrow("Recording storage changed");
	});

	it("rejects a changed source but accepts only this attempt's published output", () => {
		const token = decodedToken();
		const changed: DesktopReuploadVideo = {
			...video,
			source: { type: "desktopMP4", outputKey: "newer-output" },
		};
		expect(() =>
			assertDesktopReuploadTarget(token, changed, canonicalKey),
		).toThrow("Recording source changed");
		const published: DesktopReuploadVideo = {
			...changed,
			source: { type: "desktopMP4", outputKey },
		};
		expect(() =>
			assertDesktopReuploadTarget(token, published, canonicalKey),
		).not.toThrow();
		const moved: DesktopReuploadVideo = {
			...published,
			bucketId: Option.some(S3Bucket.S3BucketId.make("other-bucket")),
		};
		expect(() =>
			assertDesktopReuploadTarget(token, moved, canonicalKey),
		).toThrow("Recording storage changed");
	});
});
