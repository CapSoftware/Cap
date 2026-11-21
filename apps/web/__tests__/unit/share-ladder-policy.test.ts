import { describe, expect, it } from "vitest";
import {
	isShareLadderEligible,
	isShareLadderOutputKey,
	isShareLadderPlaylistFile,
	isShareLadderRetryLater,
	rewriteShareLadderMaster,
	rewriteShareLadderRendition,
	shareLadderMediaFiles,
	shareLadderOutputPrefix,
	shareLadderUploads,
} from "@/lib/share-ladder-policy";

const minute = 60;
const bytesFor = (bitsPerSecond: number, seconds: number) =>
	(bitsPerSecond * seconds) / 8;

describe("isShareLadderEligible", () => {
	it("takes shares at 6 Mbps or more", () => {
		expect(
			isShareLadderEligible({
				bytes: bytesFor(6_000_000, 10 * minute),
				durationSeconds: 10 * minute,
				width: 1920,
				height: 1080,
			}),
		).toBe(true);
		expect(
			isShareLadderEligible({
				bytes: bytesFor(5_900_000, 10 * minute),
				durationSeconds: 10 * minute,
				width: 1920,
				height: 1080,
			}),
		).toBe(false);
	});

	it("takes shares above 1080p at 4 Mbps or more", () => {
		const above1080 = { width: 3024, height: 1964, durationSeconds: 600 };
		expect(
			isShareLadderEligible({ ...above1080, bytes: bytesFor(4_000_000, 600) }),
		).toBe(true);
		expect(
			isShareLadderEligible({ ...above1080, bytes: bytesFor(3_900_000, 600) }),
		).toBe(false);
		expect(
			isShareLadderEligible({
				width: 2560,
				height: 1080,
				durationSeconds: 600,
				bytes: bytesFor(5_000_000, 600),
			}),
		).toBe(false);
	});

	it("skips short shares and unknown durations", () => {
		expect(
			isShareLadderEligible({
				bytes: bytesFor(33_000_000, 59),
				durationSeconds: 59,
				width: 3840,
				height: 2160,
			}),
		).toBe(false);
		expect(
			isShareLadderEligible({
				bytes: 1_000_000_000,
				durationSeconds: null,
				width: 3840,
				height: 2160,
			}),
		).toBe(false);
	});
});

describe("ladder keys", () => {
	it("keeps outputs inside the video's internal recording folder", () => {
		const prefix = shareLadderOutputPrefix("user1", "video1", "abc");
		expect(prefix).toBe("user1/video1/.recording/outputs/ladder-abc/");
		expect(prefix.split("/")[2]).toBe(".recording");
		expect(isShareLadderOutputKey(`${prefix}720p.m4s`, "user1", "video1")).toBe(
			true,
		);
		expect(
			isShareLadderOutputKey("user1/video1/result.mp4", "user1", "video1"),
		).toBe(false);
	});

	it("asks for every name the 1080p ladder can write", () => {
		expect(shareLadderUploads().map((upload) => upload.name)).toEqual([
			"master.m3u8",
			"1080p.m3u8",
			"1080p.m4s",
			"720p.m3u8",
			"720p.m4s",
			"360p.m3u8",
			"360p.m4s",
			"audio.m3u8",
			"audio.m4s",
		]);
	});

	it("only serves known playlist names", () => {
		expect(isShareLadderPlaylistFile("master.m3u8")).toBe(true);
		expect(isShareLadderPlaylistFile("720p.m3u8")).toBe(true);
		expect(isShareLadderPlaylistFile("audio.m3u8")).toBe(true);
		expect(isShareLadderPlaylistFile("../result.mp4")).toBe(false);
		expect(isShareLadderPlaylistFile("720p.m4s")).toBe(false);
	});
});

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_3",DEFAULT=YES,CHANNELS="2",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1218384,AVERAGE-BANDWIDTH=651212,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"
1080p.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=549720,AVERAGE-BANDWIDTH=214523,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_aud"
360p.m3u8
`;

const RENDITION = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="1080p.m4s",BYTERANGE="845@0"
#EXTINF:4.000000,
#EXT-X-BYTERANGE:331422@845
1080p.m4s
#EXTINF:4.000000,
#EXT-X-BYTERANGE:298113@332267
1080p.m4s
#EXT-X-ENDLIST
`;

describe("playlist rewriting", () => {
	it("points master entries back at the playlist route", () => {
		const rewritten = rewriteShareLadderMaster(
			MASTER,
			(file) => `/api/playlist?videoId=v&videoType=ladder&file=${file}`,
		);
		expect(rewritten).toContain(
			'URI="/api/playlist?videoId=v&videoType=ladder&file=audio.m3u8"',
		);
		expect(rewritten).toContain(
			"\n/api/playlist?videoId=v&videoType=ladder&file=1080p.m3u8\n",
		);
		expect(rewritten).toContain(
			"\n/api/playlist?videoId=v&videoType=ladder&file=360p.m3u8\n",
		);
		expect(rewritten).toContain("RESOLUTION=1920x1080");
	});

	it("refuses an unexpected master entry", () => {
		expect(() =>
			rewriteShareLadderMaster(`${MASTER}https://elsewhere/x.m3u8\n`, (f) => f),
		).toThrow();
	});

	it("signs the single media file once and keeps byte ranges", () => {
		expect(shareLadderMediaFiles(RENDITION)).toEqual(["1080p.m4s"]);
		let signed = 0;
		const rewritten = rewriteShareLadderRendition(RENDITION, (file) => {
			signed++;
			return `https://cdn.example/${file}?Signature=x`;
		});
		expect(signed).toBe(1);
		expect(rewritten).toContain(
			'#EXT-X-MAP:URI="https://cdn.example/1080p.m4s?Signature=x",BYTERANGE="845@0"',
		);
		expect(rewritten).toContain("#EXT-X-BYTERANGE:298113@332267");
		expect(rewritten.match(/cdn\.example/g)?.length).toBe(3);
		expect(rewritten).not.toMatch(/^1080p\.m4s$/m);
	});

	it("refuses media outside the ladder", () => {
		expect(() =>
			rewriteShareLadderRendition(
				RENDITION.replace(
					"1080p.m4s\n#EXT-X-ENDLIST",
					"../result.mp4\n#EXT-X-ENDLIST",
				),
				(file) => file,
			),
		).toThrow();
	});
});

describe("isShareLadderRetryLater", () => {
	it("retries a job the farm stopped for other work", () => {
		expect(
			isShareLadderRetryLater({ phase: "error", errorCode: "idle-preempted" }),
		).toBe(true);
		expect(
			isShareLadderRetryLater({
				phase: "error",
				errorCode: "processing-unavailable",
			}),
		).toBe(true);
	});

	it("fails every other ending", () => {
		expect(
			isShareLadderRetryLater({ phase: "error", errorCode: "source-invalid" }),
		).toBe(false);
		expect(isShareLadderRetryLater({ phase: "error" })).toBe(false);
		expect(
			isShareLadderRetryLater({
				phase: "cancelled",
				errorCode: "idle-preempted",
			}),
		).toBe(false);
		expect(isShareLadderRetryLater({ phase: "complete" })).toBe(false);
	});
});
