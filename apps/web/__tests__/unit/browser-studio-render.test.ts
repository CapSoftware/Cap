import { describe, expect, it } from "vitest";
import type { BrowserStudioCloudManifest } from "@/lib/browser-studio";
import {
	appendGradientBackgroundInputToArgs,
	appendTextOverlayInputsToArgs,
	buildBrowserStudioRenderPlan,
	getBrowserStudioRenderLayout,
	getBrowserStudioTrimRange,
	selectBrowserStudioRenderSources,
} from "@/lib/browser-studio-render";

const manifest = {
	schemaVersion: 1,
	videoId: "video-123",
	sessionId: "studio-session",
	source: "browser-studio-vault",
	createdAt: 100,
	updatedAt: 200,
	browser: {
		userAgent: "Safari",
		platform: "MacIntel",
	},
	project: {
		schemaVersion: 1,
		source: "browser-recorder",
		title: "Browser recording",
		timeline: {
			durationMs: 8000,
			tracks: [
				{
					trackId: "track-screen",
					assetId: "asset-screen",
					kind: "screen",
					label: "Screen",
					startMs: 0,
					durationMs: 8000,
					muted: false,
				},
				{
					trackId: "track-camera",
					assetId: "asset-camera",
					kind: "camera",
					label: "Camera",
					startMs: 0,
					durationMs: 8000,
					muted: false,
				},
			],
		},
		exportSettings: {
			format: "mp4",
			quality: "source",
		},
	},
	assets: [
		{
			assetId: "asset-screen",
			trackId: "track-screen",
			kind: "screen",
			label: "Screen",
			mimeType: "video/mp4",
			fileExtension: "mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
			sampleRate: null,
			channelCount: 2,
			totalBytes: 1,
			chunkCount: 1,
			chunks: [],
			sourceSubpath: "studio/assets/screen.mp4",
		},
		{
			assetId: "asset-camera",
			trackId: "track-camera",
			kind: "camera",
			label: "Camera",
			mimeType: "video/mp4",
			fileExtension: "mp4",
			width: 1280,
			height: 720,
			frameRate: 30,
			sampleRate: null,
			channelCount: 2,
			totalBytes: 1,
			chunkCount: 1,
			chunks: [],
			sourceSubpath: "studio/assets/camera.mp4",
		},
	],
	totalBytes: 2,
	chunkCount: 2,
	edit: {
		trim: {
			startMs: 1000,
			endMs: 6000,
		},
		playback: {
			speed: 1,
		},
		canvas: {
			aspectRatio: "1:1",
			backgroundMode: "solid",
			background: "#183d3d",
			backgroundGradient: {
				from: "#4785ff",
				to: "#ff4766",
				angle: 135,
			},
			padding: 10,
			scale: 1.1,
			cameraPosition: "bottom-right",
			cameraSize: 22,
			cameraShape: "square",
			cameraMirror: false,
		},
		audio: {
			volume: 0.7,
		},
		zooms: [],
		textOverlays: [],
	},
} satisfies BrowserStudioCloudManifest;

const sources = [
	{
		subpath: "studio/assets/screen.mp4",
		url: "https://example.com/screen.mp4",
	},
	{
		subpath: "studio/assets/camera.mp4",
		url: "https://example.com/camera.mp4",
	},
];

describe("browser studio render", () => {
	it("selects screen as primary and camera as overlay", () => {
		const selected = selectBrowserStudioRenderSources(manifest, sources);

		expect(selected.primary.asset.assetId).toBe("asset-screen");
		expect(selected.primary.url).toBe("https://example.com/screen.mp4");
		expect(selected.camera?.asset.assetId).toBe("asset-camera");
	});

	it("calculates even canvas dimensions for square exports", () => {
		const layout = getBrowserStudioRenderLayout({
			sourceWidth: 1920,
			sourceHeight: 1080,
			aspectRatio: "1:1",
			padding: 10,
		});

		expect(layout.outputWidth).toBe(1920);
		expect(layout.outputHeight).toBe(1920);
		expect(layout.contentWidth).toBe(1536);
		expect(layout.contentHeight).toBe(1536);
	});

	it("clamps trim ranges inside media duration", () => {
		const range = getBrowserStudioTrimRange(
			{
				...manifest.edit,
				trim: {
					startMs: 7900,
					endMs: 12000,
				},
			},
			8000,
		);

		expect(range.startMs).toBe(7900);
		expect(range.endMs).toBe(8000);
		expect(range.durationMs).toBe(100);
	});

	it("builds an ffmpeg plan that renders mp4 with overlay and audio volume", () => {
		const plan = buildBrowserStudioRenderPlan(manifest, sources);

		expect(plan.durationMs).toBe(5000);
		expect(plan.outputWidth).toBe(1920);
		expect(plan.outputHeight).toBe(1920);
		expect(plan.args).toContain("-filter_complex");
		expect(plan.args.join(" ")).toContain("overlay=W-w-76:H-h-76");
		expect(plan.args.join(" ")).toContain("volume=0.7");
		expect(plan.args).toContain("libx264");
	});

	it("uses camera size in overlay render dimensions", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					canvas: {
						...manifest.edit.canvas,
						cameraSize: 30,
					},
				},
			},
			sources,
		);

		expect(plan.args.join(" ")).toContain("[1:v]scale=576:576");
	});

	it("renders mirrored source-shaped camera overlays", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					canvas: {
						...manifest.edit.canvas,
						cameraSize: 30,
						cameraShape: "source",
						cameraMirror: true,
					},
				},
			},
			sources,
		);

		const args = plan.args.join(" ");

		expect(args).toContain("[1:v]hflip[camflip]");
		expect(args).toContain(
			"[camflip]scale=576:324:force_original_aspect_ratio=decrease",
		);
	});

	it("renders zoom segments as time-bounded scale and focal point expressions", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					zooms: [
						{
							id: "zoom-1",
							startMs: 2000,
							endMs: 4000,
							scale: 2,
							originX: 0.25,
							originY: 0.75,
						},
					],
				},
			},
			sources,
		);

		const args = plan.args.join(" ");

		expect(args).toContain("between(t,1,3)");
		expect(args).toContain("if(between(t,1,3),2.2,1.1)");
		expect(args).toContain("w*if(between(t,1,3),0.25,0.5)");
		expect(args).toContain("h*if(between(t,1,3),0.75,0.5)");
	});

	it("renders blurred source backgrounds from the primary video", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					canvas: {
						...manifest.edit.canvas,
						backgroundMode: "blur",
					},
				},
			},
			sources,
		);

		const args = plan.args.join(" ");

		expect(args).toContain("[0:v]split=2[bgsrc][fgsrc]");
		expect(args).toContain("boxblur=24:1");
		expect(args).toContain("[fgsrc]scale=");
	});

	it("renders timed text overlays after video composition", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					textOverlays: [
						{
							id: "text-1",
							startMs: 2000,
							endMs: 4500,
							text: "Look here: 100%",
							x: 0.5,
							y: 0.2,
							size: 48,
							color: "#ffffff",
							background: "#00000099",
						},
					],
				},
			},
			sources,
		);

		const overlay = plan.edit.textOverlays.at(0);

		expect(overlay).toBeDefined();

		if (!overlay) {
			throw new Error("Expected text overlay");
		}

		const args = appendTextOverlayInputsToArgs(
			plan.args,
			[
				{
					path: "/tmp/text-overlay.png",
					overlay,
				},
			],
			plan.trimStartSeconds,
			plan.outputWidth,
			plan.outputHeight,
		).join(" ");

		expect(args).toContain("-loop 1 -i /tmp/text-overlay.png");
		expect(args).toContain("[2:v]overlay");
		expect(args).toContain("enable='between(t,1,3.5)'");
		expect(args).toContain("-map [vtext0]");
	});

	it("keeps text overlay timing aligned after playback speed changes", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					playback: {
						speed: 2,
					},
					textOverlays: [
						{
							id: "text-1",
							startMs: 2000,
							endMs: 4000,
							text: "Fast section",
							x: 0.5,
							y: 0.2,
							size: 48,
							color: "#ffffff",
							background: "#00000099",
						},
					],
				},
			},
			sources,
		);
		const overlay = plan.edit.textOverlays.at(0);

		if (!overlay) {
			throw new Error("Expected text overlay");
		}

		const args = appendTextOverlayInputsToArgs(
			plan.args,
			[
				{
					path: "/tmp/text-overlay.png",
					overlay,
				},
			],
			plan.trimStartSeconds,
			plan.outputWidth,
			plan.outputHeight,
			plan.edit.playback.speed,
		).join(" ");

		expect(args).toContain("enable='between(t,0.5,1.5)'");
	});

	it("renders gradient backgrounds through a generated image input", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					canvas: {
						...manifest.edit.canvas,
						backgroundMode: "gradient",
					},
				},
			},
			sources,
		);

		const args = appendGradientBackgroundInputToArgs(
			plan.args,
			{ path: "/tmp/gradient-background.png" },
			plan.outputWidth,
			plan.outputHeight,
		).join(" ");

		expect(args).toContain("-loop 1 -i /tmp/gradient-background.png");
		expect(args).toContain("[2:v]scale=1920:1920,setsar=1[bg]");
		expect(args).toContain("[bg][v0]overlay");
	});

	it("renders playback speed into video timing, audio tempo, and duration", () => {
		const plan = buildBrowserStudioRenderPlan(
			{
				...manifest,
				edit: {
					...manifest.edit,
					playback: {
						speed: 2,
					},
				},
			},
			sources,
		);

		const args = plan.args.join(" ");

		expect(plan.durationMs).toBe(2500);
		expect(args).toContain("setpts=0.5*PTS");
		expect(args).toContain("atempo=2,volume=0.7");
		expect(plan.argsWithoutAudio.join(" ")).toContain("setpts=0.5*PTS");
	});
});
