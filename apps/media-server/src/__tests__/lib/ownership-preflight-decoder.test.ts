import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	preflightHash,
	preflightReceiptSchema,
	preflightRequestHash,
	requirePreflightReceipt,
} from "@cap/utils/recording-ownership-preflight";
import { decodeOwnershipPreflightFile } from "../../lib/ownership-preflight-decoder";

let directory: string;
async function ffmpeg(args: string[]) {
	const child = spawn(
		"ffmpeg",
		["-v", "error", "-y", "-threads", "1", ...args],
		{ stdio: "ignore", env: { PATH: process.env.PATH } },
	);
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (code !== 0) throw new Error("Synthetic media generation failed");
}
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "ownership-decode-synthetic-"));
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=64x64:rate=10:duration=1",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000:duration=1",
		"-c:v",
		"libx264",
		"-threads",
		"1",
		"-c:a",
		"aac",
		"-movflags",
		"+faststart",
		join(directory, "base.mp4"),
	]);
	await ffmpeg([
		"-i",
		join(directory, "base.mp4"),
		"-c:v",
		"copy",
		"-af",
		"volume=0.5",
		"-c:a",
		"aac",
		join(directory, "selected.mp4"),
	]);
	await ffmpeg([
		"-i",
		join(directory, "base.mp4"),
		"-c:v",
		"copy",
		"-an",
		join(directory, "silent.mp4"),
	]);
	await ffmpeg([
		"-i",
		join(directory, "base.mp4"),
		"-map",
		"0:v",
		"-map",
		"0:a",
		"-map",
		"0:a",
		"-c",
		"copy",
		join(directory, "extra-track.mp4"),
	]);
	const base = await readFile(join(directory, "base.mp4"));
	await writeFile(
		join(directory, "truncated.mp4"),
		base.subarray(0, base.length - 1000),
	);
	await writeFile(
		join(directory, "malformed.mp4"),
		"synthetic malformed media",
	);
});
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});
const decode = (name: string, signal = new AbortController().signal) =>
	decodeOwnershipPreflightFile(join(directory, name), 1, signal, 10000);
describe("bounded local ownership decoder", () => {
	test("fully decodes source and independently decodes selected audio derivative", async () => {
		const base = await decode("base.mp4");
		const selected = await decode("selected.mp4");
		expect(base.fullDecode).toBe(true);
		expect(base.video.frameCount).toBe(10);
		expect(base.integrity.video).toEqual(selected.integrity.video);
		expect(base.integrity.audio?.contentSha256).not.toBe(
			selected.integrity.audio?.contentSha256,
		);
		const manifest = ["base.mp4", "selected.mp4"].map((key) => ({
			key,
			size: 1,
			identity: '"synthetic"',
			versionId: null,
			contentType: "video/mp4",
			metadataHash: "a".repeat(64),
			copyMetadataHash: "a".repeat(64),
		}));
		const binding = {
			context: "a".repeat(64),
			manifest,
			assets: manifest.map((object) => ({
				ref: preflightHash(object.key),
				expectedDuration: 1,
			})),
			base: preflightHash("base.mp4"),
			selected: preflightHash("selected.mp4"),
		};
		const receipt = preflightReceiptSchema.parse({
			policy: "ownership-preflight-v1",
			context: binding.context,
			manifestHash: preflightHash(manifest),
			requestHash: preflightRequestHash(binding),
			issuedAt: Date.now(),
			expiresAt: Date.now() + 60000,
			objects: binding.assets.map((asset) => ({
				ref: asset.ref,
				sha256: "a".repeat(64),
			})),
			assets: [
				{ ref: binding.base, decode: base },
				{ ref: binding.selected, decode: selected },
			],
		});
		expect(() => requirePreflightReceipt(receipt, binding)).not.toThrow();
	});
	test("accepts silent video without fabricating an audio stream", async () => {
		const result = await decode("silent.mp4");
		expect(result.audio).toBeNull();
	});
	test.each(["truncated.mp4", "malformed.mp4", "extra-track.mp4"])(
		"holds invalid or unsupported media %s",
		async (name) => {
			await expect(decode(name)).rejects.toThrow();
		},
	);
	test("aborts verification before producing proof", async () => {
		await expect(decode("base.mp4", AbortSignal.abort())).rejects.toThrow();
	});
});
