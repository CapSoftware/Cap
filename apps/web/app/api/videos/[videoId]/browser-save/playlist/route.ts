import type { VideoMetadata } from "@cap/database/types";
import { provideOptionalAuth, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { NextResponse } from "next/server";
import { browserSavePlaylist } from "@/lib/browser-save-chunks";
import { recentBrowserSave } from "@/lib/render-farm-status";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	props: { params: Promise<{ videoId: string }> },
) {
	const videoId = Video.VideoId.make((await props.params).videoId);
	const playlist = await Effect.gen(function* () {
		const maybeVideo = yield* (yield* Videos).getByIdForViewing(videoId);
		if (Option.isNone(maybeVideo)) return null;
		const save = recentBrowserSave(
			Option.getOrNull(maybeVideo.value[0].metadata) as VideoMetadata | null,
		);
		if (!save?.saveId || !save.chunks?.length) return null;
		return browserSavePlaylist(
			videoId,
			save.saveId,
			save.chunks,
			save.finished === true,
		);
	}).pipe(provideOptionalAuth, runPromise, (promise) =>
		promise.catch(() => null),
	);
	if (!playlist) return new NextResponse(null, { status: 404 });
	return new NextResponse(playlist, {
		headers: {
			"Content-Type": "application/vnd.apple.mpegurl",
			"Cache-Control": "private, no-store",
		},
	});
}
