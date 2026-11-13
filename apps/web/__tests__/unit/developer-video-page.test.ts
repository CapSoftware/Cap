import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoPlayback,
	type DeveloperVideoQuery,
	developerVideoPlayback,
} from "@/lib/developer-video-params";
import type { DeveloperVideoPlayer } from "@/lib/developer-video-player";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
	useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("@/lib/developer-video-player", () => ({
	loadDeveloperVideoPlayer: mocks.load,
}));

const { DeveloperVideoPage, DeveloperVideoView, developerVideoMetadata } =
	await import("@/app/dev/_components/DeveloperVideoPage");
const sharePage = await import("@/app/dev/[playbackId]/page");
const embedPage = await import("@/app/dev/[playbackId]/embed/page");

const PLAYBACK_ID = "playback-id-0123456789ab";
const BASE = `https://web.example/api/developer/playback/${PLAYBACK_ID}`;
const frame = { name: "Launch demo", width: 1920, height: 1080 };

const playing: DeveloperVideoPlayer = {
	...frame,
	kind: "playing",
	source: { hls: `${BASE}/master.m3u8`, mp4: `${BASE}/video.mp4` },
	poster: `${BASE}/poster.jpg`,
};
const processing: DeveloperVideoPlayer = {
	...frame,
	kind: "processing",
	uploading: false,
};
const failed: DeveloperVideoPlayer = { ...frame, kind: "failed" };
const paused: DeveloperVideoPlayer = { ...frame, kind: "paused" };

const render = (
	player: DeveloperVideoPlayer,
	variant: "share" | "embed" = "share",
	playback?: DeveloperVideoPlayback,
) =>
	renderToStaticMarkup(
		createElement(DeveloperVideoView, { player, variant, playback }),
	);

const params = (query: DeveloperVideoQuery = {}, playbackId = PLAYBACK_ID) => ({
	params: Promise.resolve({ playbackId }),
	searchParams: Promise.resolve(query),
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.load.mockResolvedValue(playing);
});

describe("developer video page states", () => {
	it("renders the player with its poster and the video name", () => {
		const html = render(playing);

		expect(html).toContain("<video");
		expect(html).toContain(`poster="${BASE}/poster.jpg"`);
		expect(html).toContain('aria-label="Launch demo"');
		expect(html).toContain(">Launch demo</h1>");
		expect(html).toContain('aria-label="Play"');
		expect(html).toContain('role="slider"');
	});

	it("keeps the stream URLs out of the markup so nothing loads before the player decides how to play", () => {
		const html = render(playing);

		expect(html).not.toContain("master.m3u8");
		expect(html).not.toContain("video.mp4");
	});

	it("reserves the frame of the video so nothing shifts", () => {
		expect(render(playing)).toContain("aspect-ratio:1920 / 1080");
		expect(render({ ...playing, width: 1080, height: 1920 })).toContain(
			"aspect-ratio:1080 / 1920",
		);
		expect(render(processing)).toContain("aspect-ratio:1920 / 1080");
	});

	it("plays without a poster when there is none", () => {
		const html = render({ ...playing, poster: null });

		expect(html).toContain("<video");
		expect(html).not.toContain("poster=");
	});

	it("says a video is still processing and announces it", () => {
		const html = render(processing);

		expect(html).toContain("Processing video");
		expect(html).toContain(
			"This page updates when the video is ready to play.",
		);
		expect(html).toContain('role="status"');
		expect(html).not.toContain("<video");
	});

	it("says when the upload has not finished", () => {
		const html = render({ ...processing, uploading: true });

		expect(html).toContain("Waiting for the upload");
		expect(html).not.toContain("<video");
	});

	it("tells a viewer of a failed video one neutral sentence and nothing else", () => {
		const html = render(failed);
		const text = html
			.replace(/<style>.*?<\/style>/g, "")
			.replace(/<[^>]+>/g, " ");

		expect(text).toContain("This video is not available.");
		expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
		expect(text).not.toMatch(/upload|export|processed|owner|credit/i);
		expect(html).not.toContain("<video");
		expect(html).not.toContain('role="status"');
	});

	it("says playback is paused and offers nothing to play", () => {
		const html = render(paused);

		expect(html).toContain("Playback is paused");
		expect(html).not.toContain("<video");
		expect(html).not.toContain(BASE);
	});

	it.each([
		["playing", playing],
		["processing", processing],
		["failed", failed],
		["paused", paused],
	])(
		"embeds the %s state with no Cap branding or visible title",
		(_, player) => {
			const share = render(player);
			const embed = render(player, "embed");

			expect(share).toContain('aria-label="Cap Infra"');
			expect(embed).not.toContain("Cap Infra");
			expect(embed).not.toContain("<header");
			expect(embed).toContain('<h1 class="sr-only">Launch demo</h1>');
			expect(embed).not.toContain("<a ");
		},
	);

	it("fills the iframe in the embed", () => {
		const html = render(playing, "embed");

		expect(html).toContain("fixed inset-0");
		expect(html).toContain("--cap-player-ratio:auto");
		expect(html).toContain("<video");
	});
});

describe("developer video page parameters", () => {
	const embed = (query: DeveloperVideoQuery) =>
		render(playing, "embed", developerVideoPlayback(query, "embed"));

	it("asks the browser to preload nothing until the player decides", () => {
		expect(render(playing)).toContain('preload="none"');
		expect(embed({})).toContain('preload="none"');
	});

	it("shows the control bar and one labelled play button by default", () => {
		const html = embed({});

		expect(html).toContain('data-controls="true"');
		expect(html.match(/aria-label="Play"/g)).toHaveLength(1);
		expect(html).not.toContain("loop");
	});

	it("keeps a labelled play button when the control bar is hidden", () => {
		const html = embed({ controls: "0" });

		expect(html).toContain('data-controls="false"');
		expect(html.match(/aria-label="Play"/g)).toHaveLength(2);
		expect(html.indexOf('aria-label="Play"')).toBeLessThan(
			html.indexOf('role="slider"'),
		);
	});

	it("loops when asked", () => {
		expect(embed({ loop: "1" })).toContain("loop");
	});

	it("starts the sound button in its muted state", () => {
		expect(embed({ muted: "1" })).toContain('aria-label="Unmute"');
		expect(embed({})).toContain('aria-label="Mute"');
	});

	it("renders the same page for malformed and unknown parameters", () => {
		expect(
			embed({
				autoplay: "yes",
				muted: "x",
				loop: "2",
				controls: "off",
				t: "-1",
			}),
		).toBe(embed({}));
		expect(embed({ nope: "1" })).toBe(embed({}));
	});

	it("keeps the embed-only switches off the share page", () => {
		const query = { autoplay: "1", muted: "1", loop: "1", controls: "0" };

		expect(
			render(playing, "share", developerVideoPlayback(query, "share")),
		).toBe(render(playing));
	});

	it.each([
		["processing", processing],
		["failed", failed],
		["paused", paused],
	])("leaves the %s state alone", (_, player) => {
		const query = { autoplay: "1", controls: "0", t: "30" };

		expect(embed({})).not.toBe(embed(query));
		expect(
			render(player, "embed", developerVideoPlayback(query, "embed")),
		).toBe(render(player, "embed"));
	});
});

describe("developer video page routes", () => {
	it.each([
		["share", sharePage],
		["embed", embedPage],
	])(
		"titles the %s page after the video and keeps it out of search",
		async (_, page) => {
			const metadata = await page.generateMetadata(params());

			expect(metadata).toMatchObject({
				title: "Launch demo",
				description: null,
				robots: { index: false, follow: false },
				openGraph: {
					title: "Launch demo",
					images: [`${BASE}/poster.jpg`],
				},
				twitter: { card: "summary_large_image", title: "Launch demo" },
			});
			expect(mocks.load).toHaveBeenCalledWith(PLAYBACK_ID);
		},
	);

	it("previews with no image when there is nothing to play", async () => {
		mocks.load.mockResolvedValue(paused);

		expect(await developerVideoMetadata(PLAYBACK_ID)).toMatchObject({
			title: "Launch demo",
			openGraph: { images: [] },
			twitter: { card: "summary", images: [] },
		});
	});

	it.each([
		["share", "share", sharePage],
		["embed", "embed", embedPage],
	] as const)(
		"answers 404 on the %s page for a deleted or unknown video",
		async (_, variant, page) => {
			mocks.load.mockResolvedValue(null);

			const route = await page.default(params());
			await expect(
				DeveloperVideoPage({ playbackId: PLAYBACK_ID, variant, query: {} }),
			).rejects.toThrow("NOT_FOUND");
			expect(route.props).toEqual({
				playbackId: PLAYBACK_ID,
				variant,
				query: {},
			});
			expect(await page.generateMetadata(params())).toMatchObject({
				title: "Video not found",
				description: null,
				robots: { index: false, follow: false },
				openGraph: { title: "Video not found", images: [] },
			});
		},
	);

	it("renders each route in its own variant and always at request time", async () => {
		const share = await sharePage.default(params());
		const embed = await embedPage.default(params());

		expect(share.props).toEqual({
			playbackId: PLAYBACK_ID,
			variant: "share",
			query: {},
		});
		expect(embed.props).toEqual({
			playbackId: PLAYBACK_ID,
			variant: "embed",
			query: {},
		});
		expect(sharePage.dynamic).toBe("force-dynamic");
		expect(embedPage.dynamic).toBe("force-dynamic");
	});

	it("renders the loaded state", async () => {
		mocks.load.mockResolvedValue(failed);

		const html = renderToStaticMarkup(
			await DeveloperVideoPage({
				playbackId: PLAYBACK_ID,
				variant: "embed",
				query: {},
			}),
		);

		expect(html).toContain("This video is not available.");
	});

	it("hands the query of each route to the player", async () => {
		const query = { controls: "0", t: "12", loop: "1" };
		const route = await embedPage.default(params(query));

		expect(route.props.query).toEqual(query);

		const html = renderToStaticMarkup(
			await DeveloperVideoPage({
				playbackId: PLAYBACK_ID,
				variant: "embed",
				query,
			}),
		);

		expect(html).toContain('data-controls="false"');
		expect(html).toContain("loop");
	});

	it("answers a malformed query with the plain player, not an error", async () => {
		const html = renderToStaticMarkup(
			await DeveloperVideoPage({
				playbackId: PLAYBACK_ID,
				variant: "embed",
				query: { t: ["x", "y"], autoplay: "%00", controls: "" },
			}),
		);

		expect(html).toContain("<video");
		expect(html).toContain('data-controls="true"');
	});
});
