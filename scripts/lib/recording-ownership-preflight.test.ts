import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openPreflight,
	PREFLIGHT_POLICY,
	type PreflightDecode,
	type PreflightRequest,
	preflightHash,
	preflightReceiptSchema,
	sealPreflight,
} from "@cap/utils/recording-ownership-preflight";
import {
	type PreflightFetch,
	requirePreflightOrigin,
	requirePublicPreflightAddress,
} from "./ownership-preflight-download";
import {
	cleanupOwnershipPreflightScratch,
	runOwnershipPreflight,
} from "./recording-ownership-preflight";

function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing synthetic fixture");
	return value;
}
const secret = "synthetic-preflight-authentication-fixture-only";
const allowedOrigins = ["https://storage.example.test"];
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
const decoded: PreflightDecode = {
	fullDecode: true,
	video: { frameCount: 10, startTime: 0, endTime: 1, duration: 1 },
	audio: {
		frameCount: 10,
		startTime: 0,
		endTime: 1,
		duration: 1,
		sampleCount: 48000,
		sampleRate: 48000,
		decodedDuration: 1,
	},
	integrity: {
		video: {
			contentSha256: "a".repeat(64),
			timelineSha256: "b".repeat(64),
			format: "synthetic-video",
		},
		audio: {
			contentSha256: "c".repeat(64),
			timelineSha256: "d".repeat(64),
			format: "synthetic-audio",
		},
	},
};
async function fixture(two = false) {
	const directory = await mkdtemp(
		join(tmpdir(), "ownership-preflight-synthetic-"),
	);
	directories.push(directory);
	const objects = new Map([
		["test-owner/test-video/result.mp4", Buffer.from("synthetic-base")],
		...(two
			? ([
					["test-owner/test-video/audio.mp4", Buffer.from("synthetic-audio")],
				] as const)
			: []),
	]);
	const manifest = [...objects].map(([key, bytes]) => ({
		key,
		size: bytes.length,
		identity: '"synthetic-etag"',
		versionId: "synthetic-version",
		contentType: "video/mp4",
		metadataHash: preflightHash({}),
		copyMetadataHash: preflightHash({}),
	}));
	const base = preflightHash(required(manifest[0]).key);
	const request: PreflightRequest = {
		policy: PREFLIGHT_POLICY,
		context: "e".repeat(64),
		issuedAt: Date.now(),
		expiresAt: Date.now() + 3600000,
		manifest,
		reads: manifest.map((object) => ({
			ref: preflightHash(object.key),
			pinnedUrl: `${allowedOrigins[0]}/${object.key}?versionId=synthetic-version`,
			currentUrl: `${allowedOrigins[0]}/${object.key}`,
		})),
		assets: manifest.map((object) => ({
			ref: preflightHash(object.key),
			expectedDuration: 1,
		})),
		base,
		selected: preflightHash(required(manifest.at(-1)).key),
	};
	const ranges: string[] = [];
	const fetch: PreflightFetch = async (value, init) => {
		const url = new URL(value);
		const key = url.pathname.slice(1);
		const bytes = required(objects.get(key));
		const range = required(
			/^bytes=(\d+)-(\d+)$/.exec(required(init.headers.Range)),
		);
		const start = Number(range[1]);
		const end = Number(range[2]);
		expect(init.headers["If-Match"]).toBe('"synthetic-etag"');
		expect(JSON.stringify(init)).not.toContain(secret);
		ranges.push(`${url.search}:${start}-${end}`);
		return new Response(bytes.subarray(start, end + 1), {
			status: 206,
			headers: {
				"Content-Range": `bytes ${start}-${end}/${bytes.length}`,
				ETag: '"synthetic-etag"',
				"x-amz-version-id": "synthetic-version",
				"Content-Type": "video/mp4",
			},
		});
	};
	const run = (
		overrides: Partial<Parameters<typeof runOwnershipPreflight>[0]> = {},
	) =>
		runOwnershipPreflight({
			requestToken: sealPreflight("request", request, secret),
			secret,
			allowedOrigins,
			directory,
			fetch,
			chunkBytes: 4,
			decode: async () => structuredClone(decoded),
			...overrides,
		});
	return { directory, request, objects, ranges, fetch, run };
}

describe("durable synthetic ownership preflight", () => {
	test("verifies conditional versioned ranges and seals only completed full decode", async () => {
		const f = await fixture(true);
		const token = await f.run();
		const receipt = openPreflight(
			"receipt",
			token,
			secret,
			preflightReceiptSchema,
		);
		expect(receipt.assets).toHaveLength(2);
		expect(receipt.objects[0]?.sha256).toBe(
			createHash("sha256")
				.update(required([...f.objects.values()][0]))
				.digest("hex"),
		);
		expect(f.ranges.some((range) => range.startsWith("?versionId="))).toBe(
			true,
		);
		expect(
			Buffer.from(required(token.split(".")[0]), "base64url").toString(),
		).not.toMatch(/https:|synthetic-version|test-owner|authentication/);
	});
	test.each(["signature", "domain", "expired", "missing-reference", "origin"])(
		"rejects %s before storage reads",
		async (mode) => {
			const f = await fixture();
			let calls = 0;
			if (mode === "expired") f.request.expiresAt = Date.now() - 1;
			if (mode === "missing-reference") f.request.selected = "f".repeat(64);
			if (mode === "origin")
				required(f.request.reads[0]).pinnedUrl =
					"https://private.example.test/object";
			let requestToken = sealPreflight(
				mode === "domain" ? "receipt" : "request",
				f.request,
				secret,
			);
			if (mode === "signature") requestToken += "0";
			await expect(
				f.run({
					requestToken,
					fetch: async (...args) => {
						calls++;
						return f.fetch(...args);
					},
				}),
			).rejects.toThrow();
			expect(calls).toBe(0);
		},
	);
	test.each(["etag", "version", "range", "metadata", "redirect", "truncated"])(
		"holds changed %s",
		async (mode) => {
			const f = await fixture();
			await expect(
				f.run({
					fetch: async (...args) => {
						const response = await f.fetch(...args);
						if (mode === "redirect") return new Response(null, { status: 302 });
						if (mode === "truncated")
							return new Response(new Uint8Array(), {
								status: 206,
								headers: response.headers,
							});
						response.headers.set(
							required(
								(
									{
										etag: "etag",
										version: "x-amz-version-id",
										range: "content-range",
										metadata: "x-amz-meta-unexpected",
									} as Record<string, string>
								)[mode],
							),
							"changed",
						);
						return response;
					},
				}),
			).rejects.toThrow("CHANGED");
		},
	);
	test("resumes completed chunks after an interrupted range", async () => {
		const f = await fixture();
		let calls = 0;
		await expect(
			f.run({
				fetch: async (...args) => {
					if (++calls === 3) throw new Error("synthetic interruption");
					return f.fetch(...args);
				},
			}),
		).rejects.toThrow("UNAVAILABLE");
		f.ranges.length = 0;
		await f.run();
		expect(f.ranges).not.toContain("?versionId=synthetic-version:0-3");
		expect(f.ranges).toContain("?versionId=synthetic-version:4-7");
	});
	test("reuses completed assets but restarts interrupted decode", async () => {
		const f = await fixture(true);
		let calls = 0;
		await expect(
			f.run({
				decode: async () => {
					if (++calls === 2) throw new Error("synthetic interruption");
					return decoded;
				},
			}),
		).rejects.toThrow("MEDIA_INVALID");
		calls = 0;
		await f.run({
			decode: async () => {
				calls++;
				return decoded;
			},
		});
		expect(calls).toBe(1);
	});
	test.each([
		"checkpoint-signature",
		"local-bytes",
		"wrong-job",
		"untracked-file",
	])("rejects untrusted scratch %s", async (mode) => {
		const f = await fixture();
		if (mode !== "untracked-file") await f.run();
		if (mode === "checkpoint-signature")
			await writeFile(join(f.directory, "checkpoint"), "forged");
		if (mode === "local-bytes" || mode === "untracked-file")
			await writeFile(join(f.directory, `${f.request.base}.media`), "forged", {
				mode: 0o600,
			});
		if (mode === "wrong-job") f.request.context = "f".repeat(64);
		await expect(f.run()).rejects.toThrow();
		if (mode === "checkpoint-signature")
			expect(await readFile(join(f.directory, "checkpoint"), "utf8")).toBe(
				"forged",
			);
	});
	test("detects source replacement during decode before sealing", async () => {
		const f = await fixture();
		let changed = false;
		await expect(
			f.run({
				decode: async () => {
					changed = true;
					return decoded;
				},
				fetch: async (...args) => {
					const response = await f.fetch(...args);
					if (changed) response.headers.set("x-amz-version-id", "replacement");
					return response;
				},
			}),
		).rejects.toThrow("CHANGED");
	});
	test.each([
		"malformed",
		"missing-audio",
		"different-video",
		"audio-gap",
		"required-audio",
	])("rejects invalid decoder evidence: %s", async (mode) => {
		const f = await fixture(true);
		if (mode === "required-audio")
			for (const asset of f.request.assets) asset.requiredAudio = true;
		let calls = 0;
		await expect(
			f.run({
				decode: async () => {
					const value = structuredClone(decoded);
					if (mode === "malformed") value.fullDecode = false as true;
					if (++calls === 2 || mode === "required-audio") {
						if (mode === "missing-audio" || mode === "required-audio") {
							value.audio = null;
							value.integrity.audio = null;
						}
						if (mode === "different-video")
							value.integrity.video.contentSha256 = "f".repeat(64);
						if (mode === "audio-gap" && value.audio)
							value.audio.decodedDuration = 0.1;
					}
					return value;
				},
			}),
		).rejects.toThrow("MEDIA_INVALID");
	});
	test("enforces byte and wall time budgets", async () => {
		const f = await fixture();
		await expect(f.run({ maxBytes: 1 })).rejects.toThrow("LIMIT");
		await expect(f.run({ signal: AbortSignal.abort() })).rejects.toThrow(
			"INTERRUPTED",
		);
		await expect(f.run({ timeoutMs: 0 })).rejects.toThrow("LIMIT");
	});
	test("cleanup removes only authenticated local cache entries and preserves unrelated files", async () => {
		const f = await fixture();
		await f.run();
		const unrelated = join(f.directory, "synthetic-unrelated");
		await writeFile(unrelated, "preserved");
		await cleanupOwnershipPreflightScratch(
			sealPreflight("request", f.request, secret),
			secret,
			f.directory,
		);
		expect(await readFile(unrelated, "utf8")).toBe("preserved");
		await expect(
			readFile(join(f.directory, `${f.request.base}.media`)),
		).rejects.toThrow();
	});
	test("cleanup refuses a forged checkpoint and preserves cache", async () => {
		const f = await fixture();
		await f.run();
		await writeFile(join(f.directory, "checkpoint"), "forged");
		await expect(
			cleanupOwnershipPreflightScratch(
				sealPreflight("request", f.request, secret),
				secret,
				f.directory,
			),
		).rejects.toThrow("INVALID_EVIDENCE");
		expect(
			(await readFile(join(f.directory, `${f.request.base}.media`))).toString(),
		).toBe("synthetic-base");
	});

	test("holds concurrent workers and releases lock on completion", async () => {
		const f = await fixture();
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = f.run({
			decode: async () => {
				entered();
				await gate;
				return decoded;
			},
		});
		await ready;
		try {
			await expect(f.run()).rejects.toThrow("BUSY");
		} finally {
			release();
		}
		await first;
		await f.run();
	});
});

describe("storage network boundary", () => {
	test.each([
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
	])("rejects private or reserved address %s", (address) => {
		expect(() => requirePublicPreflightAddress(address)).toThrow();
	});
	test.each([
		"http://storage.example.test/object",
		"https://storage.example.test:8443/object",
		"https://storage.example.test.evil.test/object",
		"https://user:pass@storage.example.test/object",
		"https://127.0.0.1/object",
		"https://[::1]/object",
	])("rejects unapproved URL %s", (url) => {
		expect(() => requirePreflightOrigin(url, allowedOrigins)).toThrow();
	});
});
