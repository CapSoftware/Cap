import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMediaTransfers } from "../../lib/media-transfer";
import {
	materializeHlsPlaylist,
	materializeMpdAsHlsPlaylist,
	materializeMpdManifest,
} from "../../lib/media-video";

let directory: string;
let server: ReturnType<typeof Bun.serve> | undefined;
const savedEnv = { ...process.env };

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-download-policy-"));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(directory, { recursive: true, force: true });
	for (const key of [
		"MEDIA_SERVER_MAX_PLAYLIST_RESOURCES",
		"MEDIA_SERVER_MAX_PLAYLIST_BYTES",
	]) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

function serve(
	manifest: string,
	resource: (
		path: string,
		request: Request,
	) => Response | Promise<Response> = () => new Response("segment"),
) {
	const requests: string[] = [];
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push(path);
			if (path.includes("manifest.")) return new Response(manifest);
			return resource(path, request);
		},
	});
	return { url: server.url, requests };
}

describe("localized media resources", () => {
	test("inherits a Period template and timeline through representation overrides", async () => {
		const target = serve(`<MPD mediaPresentationDuration="PT2S"><Period>
			<SegmentTemplate timescale="1" media="seg-$Number$.m4s" initialization="init.mp4"><SegmentTimeline><S d="1" r="1"/></SegmentTimeline></SegmentTemplate>
			<AdaptationSet contentType="video"><Representation id="v" bandwidth="1000"><SegmentTemplate startNumber="3"/></Representation></AdaptationSet>
		</Period></MPD>`);
		const path = await materializeMpdAsHlsPlaylist(
			new URL("manifest.mpd", target.url).toString(),
			directory,
		);
		expect(await readFile(path, "utf8")).not.toContain("http:");
		expect(target.requests).toContain("/seg-3.m4s");
		expect(target.requests).toContain("/seg-4.m4s");
	});

	test("localizes single quotes and whitespace around XML attribute assignments", async () => {
		const target = serve(
			`<MPD><Period><AdaptationSet><Representation><SegmentList><Initialization sourceURL = 'init.mp4'/><SegmentURL media = 'segment.m4s'/></SegmentList></Representation></AdaptationSet></Period></MPD>`,
		);
		const path = await materializeMpdManifest(
			new URL("manifest.mpd", target.url).toString(),
			directory,
		);
		const content = await readFile(path, "utf8");
		expect(target.requests).toContain("/init.mp4");
		expect(target.requests).toContain("/segment.m4s");
		expect(content).not.toContain('media="segment.m4s"');
		expect(content).not.toContain("http:");
	});

	test("uses a working sibling when the first SegmentBase URL is missing", async () => {
		const target = serve(
			`<MPD><Location>../elsewhere/updated.mpd</Location><Period><AdaptationSet><Representation><BaseURL>primary/video.mp4</BaseURL><BaseURL>backup/video.mp4</BaseURL><SegmentBase indexRange="0-20"/></Representation></AdaptationSet></Period></MPD>`,
			(path) =>
				new Response("segment", {
					status: path.includes("primary") ? 404 : 200,
				}),
		);
		const path = await materializeMpdManifest(
			new URL("manifest.mpd", target.url).toString(),
			directory,
		);
		const content = await readFile(path, "utf8");
		expect(content.match(/<BaseURL>/g)).toHaveLength(1);
		expect(content).not.toContain("Location");
		expect(target.requests).toContain("/backup/video.mp4");
		expect(target.requests).not.toContain("/primary/backup/video.mp4");
	});

	test("fails when no SegmentBase alternative works", async () => {
		const target = serve(
			`<MPD><Period><Representation><BaseURL>primary.mp4</BaseURL><BaseURL>backup.mp4</BaseURL><SegmentBase/></Representation></Period></MPD>`,
			() => new Response("missing", { status: 404 }),
		);
		await expect(
			materializeMpdManifest(
				new URL("manifest.mpd", target.url).toString(),
				directory,
			),
		).rejects.toThrow("404");
	});

	test("downloads one copy of a byte-range HLS resource and preserves the offsets", async () => {
		const target = serve(
			"#EXTM3U\n#EXT-X-BYTERANGE:3@0\nshared.mp4\n#EXT-X-BYTERANGE:3@3\nshared.mp4\n#EXT-X-ENDLIST",
		);
		const path = await materializeHlsPlaylist(
			new URL("manifest.m3u8", target.url).toString(),
			directory,
		);
		const content = await readFile(path, "utf8");
		const resources = content
			.split("\n")
			.filter((line) => line && !line.startsWith("#"));
		expect(resources[0]).toBe(resources[1]);
		expect(content).toContain("#EXT-X-BYTERANGE:3@3");
		expect(
			target.requests.filter((path) => path === "/shared.mp4"),
		).toHaveLength(1);
	});

	test.each(["hls", "dash", "converted-dash"])(
		"stops and joins sibling downloads before a %s failure returns",
		async (kind) => {
			const manifest =
				kind === "hls"
					? "#EXTM3U\nfailed.m4s\nslow.m4s\nqueued-1.m4s\nqueued-2.m4s\nqueued-3.m4s"
					: kind === "dash"
						? `<MPD><Period><Representation><SegmentList>${["failed", "slow", "queued-1", "queued-2", "queued-3"].map((name) => `<SegmentURL media="${name}.m4s"/>`).join("")}</SegmentList></Representation></Period></MPD>`
						: `<MPD mediaPresentationDuration="PT5S"><Period><AdaptationSet contentType="video"><Representation id="v"><SegmentTemplate initialization="init.mp4" duration="1" media="seg-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`;
			let releaseSlow = () => {};
			const slowStarted = new Promise<void>((resolve) => {
				releaseSlow = resolve;
			});
			const target = serve(manifest, async (path) => {
				if (path.includes("failed") || path === "/seg-1.m4s") {
					await slowStarted;
					return new Response("missing", { status: 404 });
				}
				if (path.includes("slow") || path === "/seg-2.m4s") {
					releaseSlow();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array([1]));
							},
						}),
					);
				}
				return new Response("segment");
			});
			const materialize =
				kind === "hls"
					? materializeHlsPlaylist
					: kind === "dash"
						? materializeMpdManifest
						: materializeMpdAsHlsPlaylist;
			const url = new URL(
				kind === "hls" ? "manifest.m3u8" : "manifest.mpd",
				target.url,
			).toString();
			const operation =
				materialize === materializeHlsPlaylist
					? materializeHlsPlaylist(url, directory)
					: materialize(url, directory);
			await expect(operation).rejects.toThrow("404");
			const completedFiles = await readdir(directory);
			const requests = target.requests.length;
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(await readdir(directory)).toEqual(completedFiles);
			expect(target.requests.length).toBe(requests);
		},
		2000,
	);

	test("bounds resource counts before expanding a huge template", async () => {
		process.env.MEDIA_SERVER_MAX_PLAYLIST_RESOURCES = "5";
		const target = serve(
			`<MPD mediaPresentationDuration="PT100000000S"><Period><AdaptationSet contentType="video"><Representation><SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4" duration="1"/></Representation></AdaptationSet></Period></MPD>`,
		);
		await expect(
			materializeMpdAsHlsPlaylist(
				new URL("manifest.mpd", target.url).toString(),
				directory,
			),
		).rejects.toThrow("resource count limit");
		expect(target.requests).toHaveLength(1);
	});

	test("enforces a shared transfer byte budget while streaming resources", async () => {
		const target = serve(
			"#EXTM3U\nsegment.mp4",
			() => new Response(new Uint8Array(2048)),
		);
		await expect(
			withMediaTransfers(1024, () =>
				materializeHlsPlaylist(
					new URL("manifest.m3u8", target.url).toString(),
					directory,
				),
			),
		).rejects.toThrow("transfer budget");
	});
});
