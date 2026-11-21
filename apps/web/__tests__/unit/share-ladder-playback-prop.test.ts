import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	row: null as Record<string, unknown> | null,
	flag: { on: true, orgIds: ["org"], percent: 0, switchOnPause: false },
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				limit: async () => (mocks.row ? [mocks.row] : []),
			};
			return query;
		},
	}),
}));
vi.mock("@/lib/share-ladder-flag", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/share-ladder-flag")>()),
	readShareLadderFlag: async () => mocks.flag,
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/build-share-ladder", () => ({
	buildShareLadderWorkflow: vi.fn(),
}));
vi.mock("@/lib/share-ladder-storage", () => ({ headShareObject: vi.fn() }));
vi.mock("@/lib/share-ladder-discard", () => ({ discardShareLadder: vi.fn() }));
vi.mock("@/lib/video-view-count", () => ({ getVideoViewCount: vi.fn() }));

import { getShareLadderPlayback } from "@/lib/share-ladder";

const video = {
	id: "video" as never,
	ownerId: "owner",
	orgId: "org",
	bucket: null,
	storageIntegrationId: null,
	duration: 180,
	width: 3840,
	height: 2160,
	sourceType: "desktopMP4",
	isScreenshot: false,
	hasActiveUpload: false,
};

const readyRow = {
	state: "ready",
	sourceKey: "owner/video/result.mp4",
	sourceBytes: 738_042_654,
	outputPrefix: "owner/video/.recording/outputs/ladder-abc/",
	renditions: [
		{
			name: "1080p",
			width: 1920,
			height: 1080,
			bandwidth: 1_218_384,
			averageBandwidth: 647_184,
			codecs: "avc1.640028,mp4a.40.2",
			bytes: 14_562_483,
		},
		{
			name: "360p",
			width: 640,
			height: 360,
			bandwidth: 549_720,
			averageBandwidth: 210_448,
			codecs: "avc1.64001e,mp4a.40.2",
			bytes: 4_735_911,
		},
	],
};

describe("getShareLadderPlayback", () => {
	beforeEach(() => {
		mocks.row = readyRow;
		mocks.flag = {
			on: true,
			orgIds: ["org"],
			percent: 0,
			switchOnPause: false,
		};
	});

	it("describes a ready ladder for the player", async () => {
		expect(
			await getShareLadderPlayback(video, "owner/video/result.mp4"),
		).toEqual({
			masterUrl: "/api/playlist?videoId=video&videoType=ladder",
			renditions: [
				{ name: "1080p", width: 1920, height: 1080, bandwidth: 1_218_384 },
				{ name: "360p", width: 640, height: 360, bandwidth: 549_720 },
			],
			source: {
				width: 3840,
				height: 2160,
				bitsPerSecond: (738_042_654 * 8) / 180,
			},
			switchOnPause: false,
		});
	});

	it("offers nothing when the ladder was built from another file", async () => {
		expect(
			await getShareLadderPlayback(
				video,
				"owner/video/.recording/outputs/edit-x/result.mp4",
			),
		).toBeNull();
	});

	it("offers nothing unless the ladder is ready", async () => {
		mocks.row = { ...readyRow, state: "encoding" };
		expect(
			await getShareLadderPlayback(video, "owner/video/result.mp4"),
		).toBeNull();
	});

	it("offers nothing while the flag is off for the video", async () => {
		mocks.flag = { on: false, orgIds: [], percent: 0, switchOnPause: false };
		expect(
			await getShareLadderPlayback(video, "owner/video/result.mp4"),
		).toBeNull();
		mocks.flag = {
			on: true,
			orgIds: ["other"],
			percent: 0,
			switchOnPause: false,
		};
		expect(
			await getShareLadderPlayback(video, "owner/video/result.mp4"),
		).toBeNull();
	});

	it("offers nothing for custom buckets and storage integrations", async () => {
		expect(
			await getShareLadderPlayback(
				{ ...video, bucket: "bucket" },
				"owner/video/result.mp4",
			),
		).toBeNull();
		expect(
			await getShareLadderPlayback(
				{ ...video, storageIntegrationId: "drive" },
				"owner/video/result.mp4",
			),
		).toBeNull();
	});
});
