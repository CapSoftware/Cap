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
	captions: null,
};
const captioned: DeveloperVideoPlayer = {
	...playing,
	captions: [
		{ language: "en", label: "English", url: `${BASE}/captions-en.vtt` },
	],
};
const processing: DeveloperVideoPlayer = {
	...frame,
	kind: "processing",
	uploading: false,
};
const failed: DeveloperVideoPlayer = { ...frame, kind: "failed" };
const paused: DeveloperVideoPlayer = { ...frame, kind: "paused" };
const takenDown: DeveloperVideoPlayer = { ...frame, kind: "taken_down" };
const REPORT_HREF = `mailto:hello@cap.so?subject=Report%20video%20${PLAYBACK_ID}`;

const links = (html: string) =>
	[...html.matchAll(/<a [^>]*>[^<]*<\/a>/g)].map((match) => match[0]);

const render = (
	player: DeveloperVideoPlayer,
	variant: "share" | "embed" = "share",
	playback?: DeveloperVideoPlayback,
) =>
	renderToStaticMarkup(
		createElement(DeveloperVideoView, {
			playbackId: PLAYBACK_ID,
			player,
			variant,
			playback,
		}),
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

		expect(html).toContain("This video is being prepared");
		expect(html).not.toContain("upload");
		expect(html).not.toContain("<video");
	});

	it("tells a viewer of a failed video a neutral heading and line and nothing else", () => {
		const html = render(failed);
		const text = html
			.replace(/<style>.*?<\/style>/g, "")
			.replace(/<[^>]+>/g, " ")
			.replaceAll("&#x27;", "'");

		expect(text).toContain("This video isn't available");
		expect(text).toContain("There is nothing to play at this link.");
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
			expect(embed.match(/<a /g)).toHaveLength(1);
			expect(embed).toContain(`href="${REPORT_HREF}"`);
		},
	);

	it("fills the iframe in the embed", () => {
		const html = render(playing, "embed");

		expect(html).toContain("fixed inset-0");
		expect(html).toContain("--cap-player-ratio:auto");
		expect(html).toContain("<video");
	});
});

describe("developer video report link", () => {
	it.each([
		["playing", playing],
		["processing", processing],
		["failed", failed],
		["paused", paused],
	])(
		"offers a quiet Report link under the %s video that emails the support address with the playback id",
		(_, player) => {
			const [report, ...others] = links(render(player));

			expect(others).toEqual([]);
			expect(report).toContain(`href="${REPORT_HREF}"`);
			expect(report).toContain('aria-label="Report this video"');
			expect(report).toContain(">Report</a>");
			expect(report).not.toContain("target=");
			expect(report).not.toMatch(/uppercase|tracking-\[0\.|font-semibold/);
		},
	);

	it("tucks the embed link into the top corner, hidden until the pointer is over a player with its controls showing and no menu open", () => {
		const html = render(playing, "embed");
		const [report] = links(html);

		expect(html).toContain('class="group fixed inset-0 bg-black"');
		expect(report).toContain(`href="${REPORT_HREF}"`);
		expect(report).toContain('target="_blank"');
		expect(report).toContain('rel="noopener noreferrer"');
		expect(report).toContain("absolute right-2 top-2");
		expect(report).toContain("opacity-0");
		expect(report).toContain("pointer-events-none");
		expect(report).toContain(
			"[.group:hover:not(:has([data-idle=true])):not(:has([data-menu]))_&amp;]:opacity-100",
		);
		expect(report).toContain("focus-visible:opacity-100");
	});
});

describe("a taken down video page", () => {
	const takenDownFromLoader: DeveloperVideoPlayer = {
		name: "",
		width: 16,
		height: 9,
		kind: "taken_down",
	};

	it.each(["share", "embed"] as const)(
		"shows one plain sentence on the %s page and nothing from the video",
		async (variant) => {
			mocks.load.mockResolvedValue(takenDownFromLoader);
			const page = variant === "share" ? sharePage : embedPage;
			const route = await page.default(params());
			expect(route.props).toMatchObject({ playbackId: PLAYBACK_ID, variant });

			const html = renderToStaticMarkup(
				await DeveloperVideoPage({
					playbackId: PLAYBACK_ID,
					variant,
					query: {},
				}),
			);
			const text = html
				.replace(/<style>.*?<\/style>/g, "")
				.replace(/<[^>]+>/g, " ")
				.trim();

			expect(text).toBe("This video is not available.");
			expect(html).toContain("<h1");
			for (const absent of [
				"<video",
				"<img",
				"<a ",
				"poster",
				"m3u8",
				"video.mp4",
				"/api/developer/playback",
				PLAYBACK_ID,
				"Launch demo",
				"aspect-ratio",
				'role="status"',
				'aria-label="Cap Infra"',
			]) {
				expect(html).not.toContain(absent);
			}
		},
	);

	it("ignores every embed parameter", async () => {
		mocks.load.mockResolvedValue(takenDownFromLoader);
		const plain = renderToStaticMarkup(
			await DeveloperVideoPage({
				playbackId: PLAYBACK_ID,
				variant: "embed",
				query: {},
			}),
		);
		const styled = renderToStaticMarkup(
			await DeveloperVideoPage({
				playbackId: PLAYBACK_ID,
				variant: "embed",
				query: {
					autoplay: "1",
					muted: "1",
					controls: "0",
					t: "30",
					captions: "1",
					color: "f97316",
					radius: "16",
					quality: "720",
					quality_menu: "0",
					speed_menu: "0",
					pip: "0",
					fullscreen: "0",
					poster: "0",
					keyboard: "0",
				},
			}),
		);

		expect(styled).toBe(plain);
		expect(styled).not.toContain("f97316");
		expect(styled).not.toContain("border-radius");
	});

	it("never renders the video's own name or size even if the loader passed them", () => {
		const html = render(takenDown, "share");

		expect(html).not.toContain("Launch demo");
		expect(html).not.toContain("1920");
		expect(html).not.toContain("mailto:");
	});

	it.each([
		["share", sharePage],
		["embed", embedPage],
	])(
		"keeps the %s page out of search and previews with no title or image from the video",
		async (_, page) => {
			mocks.load.mockResolvedValue(takenDownFromLoader);

			expect(await page.generateMetadata(params())).toMatchObject({
				title: "Video not available",
				robots: { index: false, follow: false },
				openGraph: { title: "Video not available", images: [] },
				twitter: { card: "summary", title: "Video not available", images: [] },
			});
		},
	);
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

	it("offers no captions button for a video without captions", () => {
		expect(embed({})).not.toContain('aria-label="Captions"');
		expect(embed({ captions: "1" })).toBe(embed({}));
	});

	it("offers a captions button, off by default, when the video has captions", () => {
		const html = render(
			captioned,
			"embed",
			developerVideoPlayback({}, "embed"),
		);

		expect(html).toContain('aria-pressed="false"');
		expect(html).toContain('aria-label="Captions"');
	});

	it("starts with captions on when the embed asks", () => {
		const on = (captions: string) =>
			render(captioned, "embed", developerVideoPlayback({ captions }, "embed"));

		expect(on("1")).toContain('aria-pressed="true"');
		expect(on("0")).toContain('aria-pressed="false"');
	});

	it("keeps the caption file out of the markup so nothing loads before captions are on", () => {
		expect(render(captioned)).not.toContain("captions-en.vtt");
	});

	it("keeps captions off on the share page whatever the query says", () => {
		expect(
			render(
				captioned,
				"share",
				developerVideoPlayback({ captions: "1" }, "share"),
			),
		).toContain('aria-pressed="false"');
	});

	it("colours the player with the embed's accent", () => {
		expect(embed({ color: "3b82f6" })).toContain("--cap-player-accent:#3b82f6");
		expect(embed({})).not.toContain("--cap-player-accent");
	});

	it.each([
		"red;}</style><script>alert(1)</script>",
		'#fff" onload="alert(1)',
		"3b82f6;background:url(https://evil.example/x)",
	])("keeps the hostile colour %j out of the page", (color) => {
		const html = embed({ color });

		expect(html).toBe(embed({}));
		expect(html).not.toContain("evil.example");
		expect(html).not.toContain("alert(1)");
	});

	it("rounds the embed's corners on a clear page", () => {
		const html = embed({ radius: "12" });

		expect(html).toContain("border-radius:12px");
		expect(html).toContain("html,body{background:transparent}");
		expect(embed({})).toContain("html,body{background:#000}");
		expect(embed({})).not.toContain("border-radius:");
		expect(embed({ radius: "12px;}</style>" })).toBe(embed({}));
	});

	it.each([
		["failed", failed],
		["paused", paused],
	])(
		"keeps the %s embed square and opaque whatever the radius",
		(_, player) => {
			const html = render(
				player,
				"embed",
				developerVideoPlayback({ radius: "12" }, "embed"),
			);

			expect(html).not.toContain("border-radius");
			expect(html).not.toContain("background:transparent");
		},
	);

	it("leaves the poster out when asked", () => {
		expect(embed({ poster: "0" })).not.toContain("poster=");
		expect(embed({ poster: "1" })).toContain(`poster="${BASE}/poster.jpg"`);
	});

	it("hides the buttons the embed switches off", () => {
		expect(embed({})).toContain('aria-label="Full screen"');
		const html = embed({ fullscreen: "0", speed_menu: "0" });

		expect(html).not.toContain('aria-label="Full screen"');
		expect(html).not.toContain("Playback speed");
		expect(html).toContain('aria-label="Play"');
	});

	it("keeps the embed-only switches off the share page", () => {
		const query = {
			autoplay: "1",
			muted: "1",
			loop: "1",
			controls: "0",
			color: "f00",
			radius: "12",
			poster: "0",
			fullscreen: "0",
			quality: "360",
		};

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

		expect(html).toContain("This video isn&#x27;t available");
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
