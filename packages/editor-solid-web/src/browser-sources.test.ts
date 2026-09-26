import { expect, test } from "bun:test";
import {
	BrowserEditorSourceCatalog,
	parseBrowserEditorSources,
} from "./browser-sources";

function bootstrap() {
	const expiresAt = Date.now() + 20 * 60 * 1000;
	return {
		videoId: "recording-1",
		sources: {
			videoId: "recording-1",
			title: "A paired recording",
			captionsEnabled: true,
			signedUrlExpiresAt: expiresAt,
			display: {
				url: "https://media.example.com/original-display.webm?signature=a",
				contentType: "video/webm",
				fps: 30,
			},
			camera: {
				url: "https://media.example.com/original-camera.webm?signature=b",
				contentType: "video/webm",
				fps: 30,
				offsetMs: 250,
			},
			videoAssets: [
				{
					path: "content/videos/clip-display.mp4",
					url: "https://media.example.com/clip-display.mp4?signature=c",
					contentType: "video/mp4",
				},
				{
					path: "content/videos/clip-camera.mp4",
					url: "https://media.example.com/clip-camera.mp4?signature=d",
					contentType: "video/mp4",
				},
			],
			clips: [
				{
					displayPath: "content/videos/clip-display.mp4",
					cameraPath: "content/videos/clip-camera.mp4",
					fps: 30,
					cameraFps: 30,
					cameraOffsetMs: 100,
					duration: 4,
					hasAudio: false,
				},
			],
		},
	};
}

test("keeps screen and camera as separate sources across an imported clip", () => {
	const sources = parseBrowserEditorSources(bootstrap(), "recording-1");
	expect(sources.segments).toHaveLength(2);
	expect(sources.segments[0]?.display?.url).toContain("original-display");
	expect(sources.segments[0]?.camera?.url).toContain("original-camera");
	expect(sources.segments[1]?.display?.url).toContain("clip-display");
	expect(sources.segments[1]?.camera?.url).toContain("clip-camera");
	expect(sources.segments[0]?.cameraOffsetMs).toBe(250);
	expect(sources.segments[1]?.cameraOffsetMs).toBe(100);
	expect(sources.captionsEnabled).toBe(true);
});

test("keeps separately signed mic and system audio with their recording offsets", () => {
	const value = bootstrap();
	const sources = parseBrowserEditorSources(
		{
			...value,
			sources: {
				...value.sources,
				mic: {
					url: "https://media.example.com/mic.webm?signature=e",
					contentType: "audio/webm",
					offsetMs: 250,
				},
				systemAudio: {
					url: "https://media.example.com/system.mp4?signature=f",
					contentType: "audio/mp4",
					offsetMs: -75,
				},
			},
		},
		"recording-1",
	);
	expect(sources.mic?.url).toContain("mic.webm");
	expect(sources.systemAudio?.url).toContain("system.mp4");
	expect(sources.segments[0]?.micOffsetMs).toBe(250);
	expect(sources.segments[0]?.systemAudioOffsetMs).toBe(-75);
	expect(sources.segments[0]?.hasAudio).toBe(true);
});

test("rejects unsafe media URLs and unavailable camera assets", () => {
	const unsafe = bootstrap();
	unsafe.sources.camera.url = "javascript:alert(1)";
	expect(() => parseBrowserEditorSources(unsafe, "recording-1")).toThrow();
	const missing = bootstrap();
	missing.sources.videoAssets.pop();
	expect(() => parseBrowserEditorSources(missing, "recording-1")).toThrow();
	const invalidAudio = bootstrap();
	expect(() =>
		parseBrowserEditorSources(
			{
				...invalidAudio,
				sources: {
					...invalidAudio.sources,
					mic: {
						url: "javascript:alert(1)",
						contentType: "audio/webm",
						offsetMs: 0,
					},
				},
			},
			"recording-1",
		),
	).toThrow();
});

test("coalesces signed-source refresh for concurrent screen and camera requests", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = Object.assign(
		async () => {
			requests++;
			return new Response(JSON.stringify(bootstrap()), { status: 200 });
		},
		{ preconnect: originalFetch.preconnect },
	);
	const catalog = new BrowserEditorSourceCatalog("recording-1");
	const controller = new AbortController();
	try {
		const [screen, camera] = await Promise.all([
			catalog.sourceProvider(0, "display", controller.signal),
			catalog.sourceProvider(0, "camera", controller.signal),
		]);
		expect(requests).toBe(1);
		expect(screen?.url).toContain("original-display");
		expect(camera?.url).toContain("original-camera");
		catalog.invalidate();
		await catalog.snapshot(controller.signal);
		expect(requests).toBe(2);
	} finally {
		catalog.dispose();
		globalThis.fetch = originalFetch;
	}
});

test("shares browser source bootstrap across editor metadata and playback catalogs", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = Object.assign(
		async () => {
			requests++;
			return new Response(JSON.stringify(bootstrap()), { status: 200 });
		},
		{ preconnect: originalFetch.preconnect },
	);
	const metadata = new BrowserEditorSourceCatalog("recording-1");
	const playback = new BrowserEditorSourceCatalog("recording-1");
	const controller = new AbortController();
	try {
		metadata.invalidate();
		const [first, second] = await Promise.all([
			metadata.snapshot(controller.signal),
			playback.snapshot(controller.signal),
		]);
		expect(first.segments[0]?.display?.url).toBe(
			second.segments[0]?.display?.url,
		);
		expect(requests).toBe(1);
		metadata.invalidate();
		await metadata.snapshot(controller.signal);
		expect(requests).toBe(2);
	} finally {
		metadata.dispose();
		playback.dispose();
		globalThis.fetch = originalFetch;
	}
});

test("carries the owner's saved style for a project nobody has edited", () => {
	const value = bootstrap();
	const style = {
		version: 1,
		background: { padding: 12, crop: { size: { x: 1, y: 1 } } },
	};
	const sources = parseBrowserEditorSources(
		{ ...value, sources: { ...value.sources, defaultStyle: style } },
		"recording-1",
	);
	expect(sources.defaultStyle).toEqual({
		version: 1,
		background: { padding: 12 },
	});
	expect(
		parseBrowserEditorSources(bootstrap(), "recording-1").defaultStyle,
	).toBeNull();
	expect(
		parseBrowserEditorSources(
			{ ...value, sources: { ...value.sources, defaultStyle: { version: 9 } } },
			"recording-1",
		).defaultStyle,
	).toBeNull();
});
