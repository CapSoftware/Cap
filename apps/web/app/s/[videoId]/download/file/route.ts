import { getCurrentUser } from "@cap/database/auth/session";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect } from "effect";
import type { NextRequest } from "next/server";
import { loadOwnedRenderExports } from "@/lib/render-farm-download";
import {
	attachmentDisposition,
	pickRenderExport,
} from "@/lib/render-farm-status";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

const DOWNLOAD_URL_TTL_SECONDS = 10 * 60;

export async function GET(
	request: NextRequest,
	props: { params: Promise<{ videoId: string }> },
) {
	const { videoId: rawVideoId } = await props.params;
	const videoId = Video.VideoId.make(rawVideoId);
	const exportId = request.nextUrl.searchParams.get("export");
	const page = new URL(
		`/s/${encodeURIComponent(videoId)}/download`,
		request.url,
	);
	if (exportId) page.searchParams.set("export", exportId);
	const loaded = await loadOwnedRenderExports(videoId, await getCurrentUser());
	if (!loaded) return new Response("Not found", { status: 404 });
	const item = pickRenderExport(loaded.exports, exportId);
	const outputKey = loaded.video.metadata?.renderFarmExports?.items.find(
		(candidate) => candidate.exportId === item?.exportId,
	)?.outputKey;
	if (!item || item.state !== "ready" || !outputKey) {
		return Response.redirect(page, 303);
	}
	const url = await runPromise(
		Effect.gen(function* () {
			const [storage] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(loaded.video),
				{ resolvePublishedOutput: false },
			);
			return yield* storage.getSignedDownloadUrl(outputKey, {
				contentDisposition: attachmentDisposition(item.fileName),
				contentType: "video/mp4",
				expiresIn: DOWNLOAD_URL_TTL_SECONDS,
			});
		}),
	);
	return new Response(null, {
		status: 303,
		headers: { Location: url, "Cache-Control": "no-store" },
	});
}
