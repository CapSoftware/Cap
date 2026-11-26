import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectFile } from "../src/files";
import { connect, expectNoSecrets, type Session, tempFiles } from "./harness";
import { type StubApi, startStubApi } from "./stub-api";

const ascii = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);
const join = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
const tsPackets = () => {
	const out = new Uint8Array(400);
	out[0] = 0x47;
	out[188] = 0x47;
	return out;
};

const LIMIT = { maxBytes: 1e9, what: "a video" };

let files: Awaited<ReturnType<typeof tempFiles>>;

beforeEach(async () => {
	files = await tempFiles();
});

afterEach(async () => {
	await files.remove();
});

describe("local media check", () => {
	it.each([
		["MP4", "a.mp4", join(bytes(0, 0, 0, 0x18), ascii("ftypisom"))],
		["MOV", "a.mov", join(bytes(0, 0, 0, 0x14), ascii("ftypqt  "))],
		["WebM or MKV", "a.webm", bytes(0x1a, 0x45, 0xdf, 0xa3)],
		["MPEG-TS", "a.ts", tsPackets()],
		["AVI", "a.avi", join(ascii("RIFF"), bytes(0, 0, 0, 0), ascii("AVI "))],
		["WAV", "a.wav", join(ascii("RIFF"), bytes(0, 0, 0, 0), ascii("WAVE"))],
		["MP3", "a.mp3", bytes(0xff, 0xfb, 0x90, 0x64)],
		["Ogg", "a.ogg", ascii("OggS")],
	])("accepts %s", async (_label, name, header) => {
		const file = await files.write(name, 1024, header);
		await expect(inspectFile(file.path, LIMIT)).resolves.toMatchObject({
			size: 1024,
		});
	});

	it.each([
		["text", "notes.mp4", ascii("These are my notes, not a video.")],
		[
			"a PNG",
			"frame.mp4",
			bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
		],
		["an HLS playlist", "stream.mp4", ascii("#EXTM3U\n#EXT-X-VERSION:3\n")],
		["a PDF", "deck.mov", ascii("%PDF-1.7\n")],
	])("refuses %s whatever its name", async (_label, name, header) => {
		const file = await files.write(name, 1024, header);
		await expect(inspectFile(file.path, LIMIT)).rejects.toMatchObject({
			code: "not_media",
		});
	});
});

describe("videos_upload with a file that is not media", () => {
	let stub: StubApi;
	let session: Session;

	beforeEach(async () => {
		stub = await startStubApi();
		session = await connect(stub);
	});

	afterEach(async () => {
		expectNoSecrets(stub, session.output);
		await session.close();
		await stub.close();
	});

	it("refuses it before any API call", async () => {
		const file = await files.write(
			"report.mp4",
			4096,
			ascii("Quarterly report\nRevenue went up.\n"),
		);
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(true);
		expect(uploaded.body.error).toMatchObject({ code: "not_media" });
		expect(stub.requests).toHaveLength(0);
	});

	it("uploads a real container as before", async () => {
		const file = await files.write("clip.mp4", 4096);
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		expect(stub.videos.get(String(uploaded.body.videoId))?.file).toEqual(
			file.content,
		);
	});
});
