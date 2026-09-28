import type { VideoMetadata } from "@cap/database/types";
import { provideOptionalAuth, Storage, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option, Schema } from "effect";
import { NextResponse } from "next/server";
import {
	BROWSER_SAVE_CHUNK_FILE,
	browserSaveChunkKey,
} from "@/lib/browser-save-chunks";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const isSaveId = Schema.is(Schema.UUID);

export async function GET(
	_request: Request,
	props: {
		params: Promise<{ videoId: string; saveId: string; file: string }>;
	},
) {
	const { videoId, saveId, file } = await props.params;
	if (!isSaveId(saveId) || !BROWSER_SAVE_CHUNK_FILE.test(file))
		return new NextResponse(null, { status: 404 });
	const url = await Effect.gen(function* () {
		const maybeVideo = yield* (yield* Videos).getByIdForViewing(
			Video.VideoId.make(videoId),
		);
		if (Option.isNone(maybeVideo)) return null;
		const [video] = maybeVideo.value;
		const metadata = Option.getOrNull(video.metadata) as VideoMetadata | null;
		if (metadata?.browserSave?.saveId !== saveId) return null;
		const [bucket] = yield* Storage.getAccessForVideo(video);
		return yield* bucket.getSignedObjectUrl(
			browserSaveChunkKey(video.ownerId, video.id, saveId, file),
			{ expiresIn: 60 * 60 },
		);
	}).pipe(provideOptionalAuth, runPromise, (promise) =>
		promise.catch(() => null),
	);
	if (!url) return new NextResponse(null, { status: 404 });
	return NextResponse.redirect(url, {
		status: 302,
		headers: { "Cache-Control": "private, max-age=600" },
	});
}
