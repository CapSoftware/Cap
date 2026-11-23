import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localS3, memoryBucket, stopLocalS3 } from "./local-s3.test-util";
import { decodeXml, S3, type S3Config } from "./s3";

afterEach(stopLocalS3);

describe("decodeXml", () => {
	test("decodes the predefined entities", () => {
		expect(decodeXml("a&amp;b&lt;c&gt;d&quot;e&apos;f")).toBe(`a&b<c>d"e'f`);
	});

	test("decodes each entity once", () => {
		expect(decodeXml("recordings/&amp;lt;x&amp;gt;.mp4")).toBe(
			"recordings/&lt;x&gt;.mp4",
		);
	});

	test("leaves unknown entities alone", () => {
		expect(decodeXml("&nbsp;&amp")).toBe("&nbsp;&amp");
	});
});

const signingConfig: S3Config = {
	endpoint: "https://s3.us-east-1.amazonaws.com",
	region: "us-east-1",
	bucket: "media",
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	virtualHost: true,
};

// Generated with @smithy/signature-v4 5.7.4, S3 uriEscapePath=false,
// AWS URI escaping, UNSIGNED-PAYLOAD and signingDate 2026-10-26T09:00:00Z.
const signingVectors: Array<{
	name: string;
	virtualHost: boolean;
	key: string;
	query: Record<string, string>;
	path: string;
	sessionToken?: string;
	authorization: string;
	signature: string;
}> = [
	{
		name: "plain",
		virtualHost: true,
		key: "recordings/plain-file_01~.mp4",
		query: {},
		path: "/recordings/plain-file_01~.mp4",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261026/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=3fa9452a98b1c33ddc0cf4f4f125c9d253c7b6b5926a013a8967dde4681aa1d7",
		signature:
			"323571ff83f84775e3e0fa14e815ff992953a2f69c3e7d34780549bbc467d585",
	},
	{
		name: "punctuation",
		virtualHost: true,
		key: "recordings/it's (final)!*.mp4",
		query: {
			uploadId: "a!'()*+/=",
			partNumber: "2",
		},
		path: "/recordings/it%27s%20%28final%29%21%2A.mp4",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261026/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=446fa8b489deab600e2c74e315ddad474583413ff1947444be3b56a5f4350794",
		signature:
			"e0722c4dd2e78271fc07f9b4ac44fba8399aa22ceb4172e93b44c5f7cb25fd90",
	},
	{
		name: "unicode",
		virtualHost: false,
		key: "录屏/élève's (final)!*.mp4",
		query: {
			"response-content-disposition":
				'attachment; filename="élève\'s (final)!*.mp4"',
			é: "café",
			a: "x",
			Z: "z",
		},
		path: "/media/%E5%BD%95%E5%B1%8F/%C3%A9l%C3%A8ve%27s%20%28final%29%21%2A.mp4",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261026/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=2cd674629dd002513d6731ee0725b9eb9af7228d3dc1f9dfc757bc5f31058b18",
		signature:
			"50cb113e32724288d331a54d093741cfb6889836e9ea1b27c9197bb773891190",
	},
	{
		name: "session",
		virtualHost: false,
		key: "recordings/a%2Fb + c.mp4",
		query: {
			uploadId: "token+/",
			partNumber: "1",
		},
		sessionToken: "SESSION!'()*+/=",
		path: "/media/recordings/a%252Fb%20%2B%20c.mp4",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261026/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=7cd056fab18e70681b337a91755fca0e85a30d02eb5dc2b87f818b82b924a5e5",
		signature:
			"023e4a86dff4e93f96a7c8d26b7e7512879dc0eeff1ec7b34877d1aeac27863c",
	},
];

describe("S3 signing", () => {
	afterEach(() => {
		setSystemTime();
	});

	for (const vector of signingVectors) {
		test(`sign matches the AWS signer for ${vector.name}`, () => {
			setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
			const s3 = new S3({
				...signingConfig,
				virtualHost: vector.virtualHost,
				sessionToken: vector.sessionToken,
			});
			const signed = s3.sign("GET", vector.key, vector.query);
			expect(signed.headers.authorization).toBe(vector.authorization);
			expect(new URL(signed.url).pathname).toBe(vector.path);
			for (const [name, value] of Object.entries(vector.query)) {
				expect(new URL(signed.url).searchParams.get(name)).toBe(value);
			}
		});

		test(`presign matches the AWS signer for ${vector.name}`, () => {
			setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
			const s3 = new S3({
				...signingConfig,
				virtualHost: vector.virtualHost,
				sessionToken: vector.sessionToken,
			});
			const signed = new URL(s3.presign("GET", vector.key, 3600, vector.query));
			expect(signed.pathname).toBe(vector.path);
			expect(signed.searchParams.get("X-Amz-Signature")).toBe(vector.signature);
			expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
			for (const [name, value] of Object.entries(vector.query)) {
				expect(signed.searchParams.get(name)).toBe(value);
			}
			if (vector.sessionToken) {
				expect(signed.searchParams.get("X-Amz-Security-Token")).toBe(
					vector.sessionToken,
				);
			}
		});
	}

	test("copy sources use the same escaping while retaining key separators", async () => {
		const requests: { path: string; copySource: string | null }[] = [];
		const s3 = localS3(
			(request) => {
				requests.push({
					path: new URL(request.url).pathname,
					copySource: request.headers.get("x-amz-copy-source"),
				});
				return new Response(
					"<CopyPartResult><ETag>&quot;copied&quot;</ETag></CopyPartResult>",
				);
			},
			{ ...signingConfig, virtualHost: false },
		);
		expect(
			await s3.uploadPartCopy("out/export.mp4", "upload+id", 2, {
				bucket: "source-bucket",
				key: "recordings/it's (final)!*.mp4",
			}),
		).toBe('"copied"');
		expect(requests).toEqual([
			{
				path: "/media/out/export.mp4",
				copySource: "/source-bucket/recordings/it%27s%20%28final%29%21%2A.mp4",
			},
		]);
	});
});

describe("getRangeTagged", () => {
	test("reports the whole object's size, not the range's", async () => {
		const bucket = memoryBucket();
		const s3 = localS3(bucket.handle);
		await s3.put("source.mp4", new Uint8Array(1000));
		expect(await s3.getRangeTagged("source.mp4", 0, 99)).toMatchObject({
			size: 1000,
		});
		expect(
			(await s3.getRangeTagged("source.mp4", 0, 128 * 1024 - 1)).bytes
				.byteLength,
		).toBe(1000);
		expect(
			await s3.getRangeTagged("source.mp4", 0, 128 * 1024 - 1),
		).toMatchObject({ size: 1000 });

		const whole = localS3(() => new Response(new Uint8Array(30)));
		expect(await whole.getRangeTagged("source.mp4", 0, 99)).toMatchObject({
			size: 30,
		});
	});
});

describe("uploadFile", () => {
	test("a cancelled upload stops sending and aborts its multipart upload", async () => {
		const requests: string[] = [];
		const controller = new AbortController();
		const s3 = localS3((request) => {
			const url = new URL(request.url);
			requests.push(`${request.method} ${url.search}`);
			if (url.searchParams.has("uploads")) {
				return new Response(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
				);
			}
			if (url.searchParams.has("partNumber")) {
				controller.abort(new Error("cancelled"));
			}
			return new Response("", { status: 204 });
		});
		const path = join(tmpdir(), `s3-upload-${Date.now()}.bin`);
		await Bun.write(path, new Uint8Array(1024));
		await expect(
			s3.uploadFile("out/file.mp4", path, "video/mp4", {
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
		expect(requests).toEqual([
			"POST ?uploads=",
			"PUT ?partNumber=1&uploadId=u1",
			"DELETE ?uploadId=u1",
		]);
	});

	test("cleanup after a cancelled upload gives up on an unresponsive store", async () => {
		const controller = new AbortController();
		const cleanupGaveUp = Promise.withResolvers<void>();
		let cleanupAborted = false;
		const s3 = localS3(
			(request) => {
				const url = new URL(request.url);
				if (url.searchParams.has("uploads")) {
					return new Response("<UploadId>u1</UploadId>");
				}
				if (request.method === "DELETE") {
					return new Promise<Response>((resolve) => {
						request.signal.addEventListener("abort", () => {
							cleanupAborted = true;
							cleanupGaveUp.resolve();
							resolve(new Response(null, { status: 499 }));
						});
					});
				}
				controller.abort(new Error("cancelled"));
				return new Response("", { status: 204 });
			},
			{ cleanupTimeoutMs: 50 },
		);
		const path = join(tmpdir(), `s3-cleanup-${Date.now()}.bin`);
		await Bun.write(path, new Uint8Array(16));
		const started = performance.now();
		await expect(
			s3.uploadFile("out/file.mp4", path, "video/mp4", {
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
		const elapsed = performance.now() - started;
		await cleanupGaveUp.promise;
		expect(cleanupAborted).toBe(true);
		expect(elapsed).toBeLessThan(5_000);
	});
});
