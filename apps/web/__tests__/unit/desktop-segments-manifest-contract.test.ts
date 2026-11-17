import { Video } from "@cap/web-domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readCompletedRecordingManifest } from "@/lib/desktop-recording-verification";
import videoOnly from "../fixtures/desktop-segments/finished-manifest-video-only.json";
import withAudio from "../fixtures/desktop-segments/finished-manifest-with-audio.json";

// The desktop app's own test writes these files from the manifest it uploads
// (`finished_segment_manifests_match_the_server_contract_fixtures` in
// apps/desktop-gpui/src/upload.rs), so a format change on either side fails
// one of the two tests.
describe("desktop segment manifest contract", () => {
	it.each([
		["with audio", withAudio, true, [1, 2]],
		["video only", videoOnly, false, []],
	])(
		"finalization accepts the finished manifest the app uploads (%s)",
		(_, fixture, hasAudio, audioSegments) => {
			const completed = readCompletedRecordingManifest(JSON.stringify(fixture));
			expect(completed.hasAudio).toBe(hasAudio);
			expect(completed.videoSegments).toEqual([1, 2, 3]);
			expect(completed.audioSegments).toEqual(audioSegments);
		},
	);

	it.each([
		["with audio", withAudio],
		["video only", videoOnly],
	])(
		"recovery reads the finished manifest the app uploads (%s)",
		(_, fixture) => {
			const manifest = Schema.decodeUnknownSync(Video.SegmentManifest)(fixture);
			expect(manifest.is_complete).toBe(true);
			expect(manifest.video_init_uploaded).toBe(true);
			expect(manifest.video_segments).toHaveLength(3);
		},
	);
});
