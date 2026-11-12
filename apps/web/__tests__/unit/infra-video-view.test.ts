import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://web.example",
		INFRA_PLAYBACK_URL: undefined,
	}),
}));

import {
	developerVideoIsReady,
	developerVideoPageUrls,
	developerVideoPlaybackUrls,
} from "@/lib/developer-video-api";
import {
	INFRA_VIDEO_DISPLAY_LABELS,
	INFRA_VIDEO_FAILURE_FALLBACK,
	INFRA_VIDEO_PAGE_MAX,
	INFRA_VIDEO_PUBLIC_FAILURE,
	infraRefreshDelayMs,
	infraVideoDisplayState,
	infraVideoEmbedCode,
	infraVideoFailure,
	infraVideoIsChanging,
	infraVideoListLimit,
	infraVideoListPage,
	infraVideoState,
	toInfraVideoDetail,
	toInfraVideoListItem,
} from "@/lib/infra-video-view";
import { developerVideo, processingState } from "../fixtures/developer-video";

const row = (overrides: Parameters<typeof developerVideo>[0] = {}) => {
	const video = developerVideo(overrides);
	return {
		...video,
		legacy: video.playbackId === null && video.processing === null,
	};
};

const LIST_FIELDS = [
	"createdAt",
	"duration",
	"externalUserId",
	"id",
	"name",
	"state",
];

const DETAIL_FIELDS = [
	...LIST_FIELDS,
	"embedCode",
	"failure",
	"height",
	"hlsUrl",
	"mp4Url",
	"posterUrl",
	"shareUrl",
	"sizes",
	"stillEncoding",
	"storedBytes",
	"width",
].sort();

describe("infraVideoState", () => {
	it("names each stage of a video", () => {
		expect(infraVideoState(row({ status: "uploading", duration: null }))).toBe(
			"uploading",
		);
		expect(infraVideoState(row({ status: "processing" }))).toBe("processing");
		expect(infraVideoState(row({ status: "ready" }))).toBe("ready");
		expect(infraVideoState(row({ status: "errored" }))).toBe("failed");
	});

	it("agrees with the API about which videos are ready", () => {
		const cases = [
			row({ status: "ready" }),
			row({ status: "processing" }),
			row({ status: "errored" }),
			row({ status: "uploading", duration: null, width: null }),
			row({ status: "uploading", playbackId: null, processing: null }),
			row({
				status: "uploading",
				playbackId: null,
				processing: null,
				duration: null,
			}),
			row({
				status: "uploading",
				playbackId: null,
				processing: null,
				width: null,
			}),
			row({ status: "uploading", playbackId: null }),
		];
		for (const video of cases) {
			expect(infraVideoState(video) === "ready").toBe(
				developerVideoIsReady(video),
			);
		}
	});
});

describe("infraVideoFailure", () => {
	it("passes on the sentences written for customers", () => {
		for (const reason of [
			"This file has no video track.",
			"This video could not be processed. Upload it again, or export it as an MP4 and upload that.",
			"The uploaded file is empty. Upload it again.",
			"Not enough credit to store this video at its measured length and size. Add at least $0.01 of credit and upload it again.",
			"Video is longer than the 4 hour limit",
		]) {
			expect(infraVideoFailure(reason)).toBe(reason);
		}
	});

	it("replaces encoder wording with a sentence a customer can act on", () => {
		for (const reason of [
			"Encoded MP4 was not stored",
			"Encoder reported no renditions",
			"Video processing is not available on the media server",
			"ffmpeg exited with code 1: [url]",
			"",
			null,
		]) {
			expect(infraVideoFailure(reason)).toBe(INFRA_VIDEO_FAILURE_FALLBACK);
		}
	});
});

describe("the sentence a viewer of the public page gets", () => {
	it("is one sentence with no advice and nothing about the owner's account", () => {
		expect(INFRA_VIDEO_PUBLIC_FAILURE).toBe("This video is not available.");
		expect(INFRA_VIDEO_PUBLIC_FAILURE).not.toMatch(
			/credit|balance|billing|payment|upload|export|owner/i,
		);
	});
});

describe("console video payload", () => {
	it("sends the list exactly the fields it shows", () => {
		const item = toInfraVideoListItem(row({ status: "ready" }));
		expect(Object.keys(item).sort()).toEqual(LIST_FIELDS);
	});

	it("sends the video page exactly the fields it shows", () => {
		const video = row({
			status: "ready",
			storedBytes: 9_000_000,
			renditions: [
				{
					name: "1080p",
					width: 1920,
					height: 1080,
					bitrate: 5_000_000,
					bytes: 8_000_000,
					codecs: "avc1.640028,mp4a.40.2",
				},
			],
			processing: processingState({
				hls: { state: "complete", output: "out-hls" },
				mp4: { state: "complete", output: "out-mp4" },
				poster: { output: "out-mp4" },
			}),
		});
		const detail = toInfraVideoDetail(video, developerVideoPlaybackUrls(video));

		expect(Object.keys(detail).sort()).toEqual(DETAIL_FIELDS);
		expect(detail.sizes).toEqual([
			{ name: "1080p", width: 1920, height: 1080, bytes: 8_000_000 },
		]);
		expect(detail.hlsUrl).toBe(
			"https://web.example/api/developer/playback/playback-id-0123456789ab/master.m3u8",
		);
		expect(detail.mp4Url).toContain("/playback-id-0123456789ab/");
		expect(detail.posterUrl).toContain("/playback-id-0123456789ab/");
		expect(detail.stillEncoding).toBe(false);
		expect(detail.failure).toBeNull();

		const sent = JSON.stringify(detail);
		expect(sent).not.toContain("developer/app-1/video-1/video");
		expect(sent).not.toContain("encode-1");
		expect(sent).not.toContain("out-hls");
		expect(sent).not.toContain("avc1");
	});

	it("says when one format is still on its way", () => {
		const video = row({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "out-mp4" },
				hls: { state: "running", token: "t", jobId: "j", startedAt: 1 },
			}),
		});
		const detail = toInfraVideoDetail(video, developerVideoPlaybackUrls(video));

		expect(detail.state).toBe("ready");
		expect(detail.mp4Url).not.toBeNull();
		expect(detail.hlsUrl).toBeNull();
		expect(detail.stillEncoding).toBe(true);
	});

	it("does not wait on a format that failed for good", () => {
		const video = row({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "out-mp4" },
				hls: { state: "failed", reason: "Encoder reported no renditions" },
			}),
		});

		expect(
			toInfraVideoDetail(video, developerVideoPlaybackUrls(video))
				.stillEncoding,
		).toBe(false);
	});

	describe("share link and embed code", () => {
		const PAGE = "https://web.example/dev/playback-id-0123456789ab";
		const page = developerVideoPageUrls("playback-id-0123456789ab");

		it("gives a video its hosted player link and an iframe in its own shape", () => {
			const video = row({ status: "ready", width: 1080, height: 1920 });

			const detail = toInfraVideoDetail(
				video,
				developerVideoPlaybackUrls(video),
				page,
			);

			expect(detail.shareUrl).toBe(PAGE);
			expect(detail.embedCode).toBe(
				`<iframe src="${PAGE}/embed" title="${video.name}" style="width: 100%; aspect-ratio: 1080 / 1920; border: 0" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`,
			);
		});

		it("offers them while the video is still processing", () => {
			const video = row({ status: "processing", width: null, height: null });

			const detail = toInfraVideoDetail(
				video,
				developerVideoPlaybackUrls(video),
				page,
			);

			expect(detail.hlsUrl).toBeNull();
			expect(detail.shareUrl).toBe(PAGE);
			expect(detail.embedCode).toContain("aspect-ratio: 16 / 9;");
		});

		it("offers neither for a failed video or one with no player page", () => {
			const failed = row({ status: "errored", errorReason: "x" });
			const ready = row({ status: "ready" });

			expect(
				toInfraVideoDetail(failed, developerVideoPlaybackUrls(failed), page),
			).toMatchObject({ shareUrl: null, embedCode: null });
			expect(
				toInfraVideoDetail(ready, developerVideoPlaybackUrls(ready)),
			).toMatchObject({ shareUrl: null, embedCode: null });
		});

		it("keeps a video name from breaking out of the title attribute", () => {
			const code = infraVideoEmbedCode(`${PAGE}/embed`, {
				name: 'Demo "one" <script>alert(1)</script> & more',
				width: 1920,
				height: 1080,
			});

			expect(code).toContain(
				'title="Demo &quot;one&quot; &lt;script&gt;alert(1)&lt;/script&gt; &amp; more"',
			);
			expect(code.match(/<script/g)).toBeNull();
			expect(code.split('"').length).toBe(11);
		});
	});

	it("gives a failed video a customer-worded reason and no links", () => {
		const video = row({
			status: "errored",
			errorReason: "Encoder reported no renditions",
			processing: processingState({
				mp4: { state: "failed", reason: "Encoder reported no renditions" },
				hls: { state: "failed", reason: "Encoder reported no renditions" },
			}),
		});
		const detail = toInfraVideoDetail(video, developerVideoPlaybackUrls(video));

		expect(detail.state).toBe("failed");
		expect(detail.failure).toBe(INFRA_VIDEO_FAILURE_FALLBACK);
		expect(detail.hlsUrl).toBeNull();
		expect(detail.mp4Url).toBeNull();
		expect(detail.posterUrl).toBeNull();
	});

	it("shows a video from before encoding as ready with nothing to play", () => {
		const video = row({
			status: "uploading",
			playbackId: null,
			processing: null,
		});
		const detail = toInfraVideoDetail(video, developerVideoPlaybackUrls(video));

		expect(detail.state).toBe("ready");
		expect(detail.hlsUrl).toBeNull();
		expect(detail.mp4Url).toBeNull();
		expect(detail.stillEncoding).toBe(false);
	});
});

describe("list refresh", () => {
	const now = Date.parse("2026-11-01T12:00:00Z");
	const created = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

	it("watches processing videos and recent uploads only", () => {
		expect(
			infraVideoIsChanging(
				{ state: "processing", createdAt: created(600) },
				now,
			),
		).toBe(true);
		expect(
			infraVideoIsChanging({ state: "uploading", createdAt: created(5) }, now),
		).toBe(true);
		expect(
			infraVideoIsChanging({ state: "uploading", createdAt: created(61) }, now),
		).toBe(false);
		expect(
			infraVideoIsChanging({ state: "ready", createdAt: created(1) }, now),
		).toBe(false);
		expect(
			infraVideoIsChanging({ state: "failed", createdAt: created(1) }, now),
		).toBe(false);
	});

	it("slows down and then stops", () => {
		expect(infraRefreshDelayMs(0)).toBe(3_000);
		expect(infraRefreshDelayMs(119_000)).toBe(3_000);
		expect(infraRefreshDelayMs(120_000)).toBe(10_000);
		expect(infraRefreshDelayMs(30 * 60_000)).toBeNull();
	});
});

describe("what a video row says while this tab knows more than the list", () => {
	it("shows the server's state once the video has left uploading", () => {
		for (const state of ["processing", "ready", "failed"] as const) {
			for (const local of ["sending", "sent", null] as const) {
				expect(infraVideoDisplayState(state, local)).toBe(state);
			}
		}
	});

	it("says uploading while this tab is sending the file", () => {
		expect(infraVideoDisplayState("uploading", "sending")).toBe("uploading");
	});

	it("says processing once the server accepted the file, before the list catches up", () => {
		expect(infraVideoDisplayState("uploading", "sent")).toBe("processing");
		expect(INFRA_VIDEO_DISPLAY_LABELS.processing).toBe("Processing");
	});

	it("only calls an upload unfinished when this tab has nothing to do with it", () => {
		expect(infraVideoDisplayState("uploading", null)).toBe("unfinished");
		expect(INFRA_VIDEO_DISPLAY_LABELS.unfinished).toBe("Upload not finished");
	});
});

describe("how many videos the list shows", () => {
	it("starts at fifty", () => {
		for (const show of [undefined, null, "", "abc", "0", "-5", "50", "12"]) {
			expect(infraVideoListLimit(show)).toBe(50);
		}
	});

	it("grows in steps of fifty and stops at the cap", () => {
		expect(infraVideoListLimit("100")).toBe(100);
		expect(infraVideoListLimit("101")).toBe(150);
		expect(infraVideoListLimit(["150", "900"])).toBe(150);
		expect(infraVideoListLimit("1000000")).toBe(INFRA_VIDEO_PAGE_MAX);
		expect(infraVideoListLimit("Infinity")).toBe(50);
	});

	it("knows there are more from one extra row", () => {
		const rows = Array.from({ length: 51 }, (_, index) => index);
		expect(infraVideoListPage(rows, 50)).toEqual({
			rows: rows.slice(0, 50),
			hasMore: true,
			nextLimit: 100,
		});
		expect(infraVideoListPage(rows.slice(0, 50), 50)).toEqual({
			rows: rows.slice(0, 50),
			hasMore: false,
			nextLimit: null,
		});
		expect(infraVideoListPage([], 50)).toEqual({
			rows: [],
			hasMore: false,
			nextLimit: null,
		});
	});

	it("offers no further step at the cap", () => {
		const rows = Array.from(
			{ length: INFRA_VIDEO_PAGE_MAX + 1 },
			(_, index) => index,
		);
		const page = infraVideoListPage(rows, INFRA_VIDEO_PAGE_MAX);
		expect(page.hasMore).toBe(true);
		expect(page.nextLimit).toBeNull();
		expect(page.rows).toHaveLength(INFRA_VIDEO_PAGE_MAX);
		expect(infraVideoListPage(rows, 950).nextLimit).toBe(INFRA_VIDEO_PAGE_MAX);
	});
});
