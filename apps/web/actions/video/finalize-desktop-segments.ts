"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import type { Video } from "@cap/web-domain";
import { completeDesktopSegmentsManifestAndQueue } from "@/lib/desktop-segments-recovery";

export async function finalizeDesktopSegmentsRecording({
	videoId,
}: {
	videoId: Video.VideoId;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const result = await completeDesktopSegmentsManifestAndQueue({
		videoId,
		userId: user.id,
	});

	if (result.status === "not-found") throw new Error("Video not found");
	if (result.status === "not-segmented") {
		throw new Error("Video is not a segmented recording");
	}
	if (result.status === "missing-manifest") {
		throw new Error("Segment manifest not found");
	}
	if (result.status === "invalid-manifest") {
		throw new Error("Segment manifest is invalid");
	}
	if (result.status === "no-video-segments") {
		throw new Error("No video segments found");
	}
	if (result.status === "manifest-changed") {
		throw new Error("Segment manifest changed while finalizing");
	}

	return result;
}
