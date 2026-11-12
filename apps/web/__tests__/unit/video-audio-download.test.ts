import type { VideosPolicy as VideosPolicyService } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Settings = Record<string, unknown> | null;

const mocks = vi.hoisted(() => ({
	tables: new Map<string, unknown[]>(),
	sign: vi.fn(),
	access: vi.fn(),
	viewer: null as { id: string; email: string } | null,
	isMember: false,
	shareLimited: false,
	rateLimited: false,
	linkOpenToAnyone: false,
	allowedEmailDomain: null as string | null,
	spacePasswords: [] as string[],
	verifiedPasswords: [] as string[],
	mediaServerConfigured: true,
	audioRateLimited: false,
	hasAudio: vi.fn(),
	stream: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { getTableName } = await import("drizzle-orm");
	return {
		db: () => ({
			select: () => ({
				from: (table: Parameters<typeof getTableName>[0]) => ({
					where: () =>
						Promise.resolve(mocks.tables.get(getTableName(table)) ?? []),
				}),
			}),
		}),
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () =>
		Promise.resolve(
			mocks.viewer && {
				...mocks.viewer,
				activeOrganizationId: "viewer-organization",
				image: null,
			},
		),
}));
vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	class VideosPolicy extends Effect.Service<VideosPolicy>()("VideosPolicy", {
		sync: () => ({
			canViewLoaded: (
				video: Parameters<typeof actual.buildCanViewLoaded>[1],
				password: Option.Option<string>,
			) =>
				actual.buildCanViewLoaded(
					{
						repo: {
							getById: () => Effect.succeedNone,
							hasViewerGrant: () => Effect.succeed(false),
							isLinkOpenToAnyone: () => Effect.succeed(mocks.linkOpenToAnyone),
						},
						orgsRepo: {
							membershipForVideo: () =>
								Effect.succeed(
									mocks.isMember ? [{ membershipId: "member" }] : [],
								),
							allowedEmailDomain: () =>
								Effect.succeed(Option.fromNullable(mocks.allowedEmailDomain)),
						},
						spacesRepo: {
							membershipForVideo: () => Effect.succeedNone,
							passwordsForVideo: () =>
								Effect.succeed(
									mocks.spacePasswords.map((password) => ({ password })),
								),
						},
					},
					video,
					password,
				),
		}),
	}) {}
	return {
		Storage: { getAccessForVideo: mocks.access },
		VideosPolicy,
		makeCurrentUser: actual.makeCurrentUser,
		attachmentContentDisposition: actual.attachmentContentDisposition,
	};
});
vi.mock("@/lib/video-download-permissions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/video-download-permissions")
	>()),
	canUserDownloadVideo: () => Promise.resolve(mocks.isMember),
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoLockedByShareableLinkLimit: () => Promise.resolve(mocks.shareLimited),
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: {
		VIEWER_DOWNLOAD: "rl_viewer_download",
		AUDIO_DOWNLOAD: "rl_audio_download",
	},
	isRateLimited: (ruleId: string) =>
		Promise.resolve(
			ruleId === "rl_audio_download"
				? mocks.audioRateLimited
				: mocks.rateLimited,
		),
}));
vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => mocks.mediaServerConfigured,
	checkHasAudioTrackViaMediaServer: mocks.hasAudio,
	streamAudioViaMediaServer: mocks.stream,
}));
vi.mock("@/lib/server", async () => {
	const backend = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(
			effect: Effect.Effect<
				A,
				E,
				VideosPolicyService | Video.VideoPasswordAttachment
			>,
		) =>
			effect.pipe(
				Effect.provide(backend.VideosPolicy.Default),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.verifiedPasswords,
				}),
				Effect.runPromise,
			),
	};
});

import { getVideoAudioDownloadInfo } from "@/actions/videos/download";
import { GET } from "@/app/api/videos/[videoId]/audio/route";

const VIDEO = Video.VideoId.make("video");
const CURRENT_KEY = "owner/video/result.mp4";
const INTERNAL_URL = "http://minio:9000/bucket/owner/video/result.mp4?sig";
const AUDIO_URL = "/api/videos/video/audio";
const stranger = { id: "stranger", email: "stranger@elsewhere.test" };
const member = { id: "member", email: "member@example.com" };
const OFF = { disableDownloads: true };

const setVideo = ({
	videoSettings = null,
	isPublic = true,
	password = null,
	sourceType = "desktopMP4",
	name = "Weekly sync",
}: {
	videoSettings?: Settings;
	isPublic?: boolean;
	password?: string | null;
	sourceType?: string;
	name?: string;
} = {}) => {
	mocks.tables.set("videos", [
		{
			id: "video",
			ownerId: "owner",
			orgId: "organization",
			name,
			public: isPublic,
			password,
			settings: videoSettings,
			source: { type: sourceType },
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	]);
	mocks.tables.set("organizations", [{ settings: null }]);
};

const callRoute = (signal?: AbortSignal) =>
	GET(new Request(`https://cap.example${AUDIO_URL}`, { signal }), {
		params: Promise.resolve({ videoId: "video" }),
	} as Parameters<typeof GET>[1]);

const streamOf = (text: string) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});

beforeEach(() => {
	mocks.tables.clear();
	mocks.viewer = null;
	mocks.isMember = false;
	mocks.shareLimited = false;
	mocks.rateLimited = false;
	mocks.linkOpenToAnyone = false;
	mocks.allowedEmailDomain = null;
	mocks.spacePasswords = [];
	mocks.verifiedPasswords = [];
	mocks.mediaServerConfigured = true;
	mocks.audioRateLimited = false;
	mocks.sign.mockReset();
	mocks.access.mockReset();
	mocks.hasAudio.mockReset();
	mocks.stream.mockReset();
	mocks.sign.mockReturnValue(Effect.succeed(INTERNAL_URL));
	mocks.hasAudio.mockResolvedValue(true);
	mocks.stream.mockResolvedValue({ status: "ok", body: streamOf("ID3") });
	mocks.access.mockReturnValue(
		Effect.succeed([
			{
				headObject: () => Effect.succeed({}),
				getInternalSignedObjectUrl: mocks.sign,
			},
		]),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getVideoAudioDownloadInfo", () => {
	it("checks the published MP4 for audio and points the browser at the audio route", async () => {
		setVideo();
		expect(await getVideoAudioDownloadInfo(VIDEO)).toEqual({
			success: true,
			downloadUrl: AUDIO_URL,
			filename: "Weekly sync.mp3",
		});
		expect(mocks.sign.mock.calls[0]?.[0]).toBe(CURRENT_KEY);
		expect(mocks.hasAudio).toHaveBeenCalledWith(INTERNAL_URL);
	});

	it("explains that a video without an audio track has nothing to download", async () => {
		setVideo();
		mocks.hasAudio.mockResolvedValue(false);
		expect(await getVideoAudioDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "This video has no audio to download.",
		});
	});

	it("does not offer audio when no media server is configured", async () => {
		mocks.mediaServerConfigured = false;
		setVideo();
		expect(await getVideoAudioDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "Audio downloads are not available on this server.",
		});
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it("follows the viewer download setting", async () => {
		setVideo({ videoSettings: OFF });
		expect(await getVideoAudioDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "Video not found",
		});
		mocks.viewer = stranger;
		expect(await getVideoAudioDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "You don't have permission to download this video",
		});
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.hasAudio).not.toHaveBeenCalled();

		mocks.viewer = member;
		mocks.isMember = true;
		expect(await getVideoAudioDownloadInfo(VIDEO)).toMatchObject({
			success: true,
		});
	});

	it("denies a private video to viewers", async () => {
		setVideo({ isPublic: false });
		mocks.viewer = stranger;
		expect(await getVideoAudioDownloadInfo(VIDEO)).toMatchObject({
			success: false,
		});
		expect(mocks.hasAudio).not.toHaveBeenCalled();
	});

	it("requires the video password to be verified first", async () => {
		setVideo({ password: "video-hash" });
		expect(await getVideoAudioDownloadInfo(VIDEO)).toMatchObject({
			success: false,
		});
		mocks.verifiedPasswords = ["video-hash"];
		expect(await getVideoAudioDownloadInfo(VIDEO)).toMatchObject({
			success: true,
		});
	});

	it("waits until processing has finished", async () => {
		setVideo();
		mocks.tables.set("video_uploads", [{ phase: "processing" }]);
		expect(await getVideoAudioDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "Video is still processing. Try again once it has finished.",
		});
		expect(mocks.hasAudio).not.toHaveBeenCalled();
	});

	it("names the file after the video", async () => {
		setVideo({ name: "Q4 planning: draft" });
		expect(await getVideoAudioDownloadInfo(VIDEO)).toMatchObject({
			filename: "Q4 planning: draft.mp3",
		});
	});
});

describe("GET /api/videos/[videoId]/audio", () => {
	it("streams the MP3 as an attachment named after the video", async () => {
		setVideo();
		const response = await callRoute();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/mpeg");
		expect(response.headers.get("content-disposition")).toContain(
			"Weekly sync.mp3",
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.text()).toBe("ID3");
		expect(mocks.stream.mock.calls[0]?.[0]).toBe(INTERNAL_URL);
	});

	it("checks access again instead of trusting the URL", async () => {
		setVideo({ videoSettings: OFF });
		const response = await callRoute();
		expect(response.status).toBe(404);
		expect(mocks.stream).not.toHaveBeenCalled();

		mocks.viewer = stranger;
		expect((await callRoute()).status).toBe(403);
		expect(mocks.stream).not.toHaveBeenCalled();
	});

	it("returns 422 for a video without an audio track", async () => {
		setVideo();
		mocks.stream.mockResolvedValue({ status: "no-audio" });
		const response = await callRoute();
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "This video has no audio to download.",
		});
	});

	it("passes the request signal on so a cancelled download stops extraction", async () => {
		setVideo();
		const controller = new AbortController();
		await callRoute(controller.signal);
		const forwarded = mocks.stream.mock.calls[0]?.[1] as AbortSignal;
		controller.abort();
		expect(forwarded.aborted).toBe(true);
	});

	it("reports a media server failure as a bad gateway", async () => {
		setVideo();
		mocks.stream.mockRejectedValue(new Error("Server is busy"));
		expect((await callRoute()).status).toBe(502);
	});

	it("rate limits audio extraction for members too", async () => {
		mocks.viewer = member;
		mocks.isMember = true;
		mocks.audioRateLimited = true;
		setVideo();
		expect((await callRoute()).status).toBe(429);
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.stream).not.toHaveBeenCalled();
	});

	it("rate limits viewers before touching storage", async () => {
		mocks.rateLimited = true;
		setVideo();
		expect((await callRoute()).status).toBe(429);
		expect(mocks.access).not.toHaveBeenCalled();
	});
});
