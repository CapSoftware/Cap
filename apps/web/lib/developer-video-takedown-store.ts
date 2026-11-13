import { db } from "@cap/database";
import {
	restoredMetadataSql,
	takenDownMetadataSql,
} from "@cap/database/developer-video-takedown";
import { developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
	DEVELOPER_VIDEO_UNAVAILABLE,
	developerVideoIsTakenDown,
	developerVideoReference,
	developerVideoTakenDownAt,
} from "./developer-video-takedown";

export type DeveloperVideoTakedownResult = {
	videoId: string;
	appId: string;
	playbackId: string | null;
	takenDown: boolean;
	takenDownAt: string | null;
	changed: boolean;
};

type Executor = Pick<ReturnType<typeof db>, "select" | "update">;

async function lockVideo(
	tx: Executor,
	column: "playbackId" | "id",
	value: string,
) {
	const [video] = await tx
		.select({
			id: developerVideos.id,
			appId: developerVideos.appId,
			playbackId: developerVideos.playbackId,
			metadata: developerVideos.metadata,
		})
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos[column], value),
				isNull(developerVideos.deletedAt),
			),
		)
		.for("update");
	return video ?? null;
}

export async function setDeveloperVideoTakedown(
	input: string,
	takenDown: boolean,
	now: Date = new Date(),
): Promise<DeveloperVideoTakedownResult | null> {
	const reference = developerVideoReference(input);
	if (!reference) return null;
	return db().transaction(async (tx) => {
		const video =
			(await lockVideo(tx, "playbackId", reference)) ??
			(await lockVideo(tx, "id", reference));
		if (!video) return null;

		const wasTakenDown = developerVideoIsTakenDown(video);
		const changed = wasTakenDown !== takenDown;
		if (changed) {
			await tx
				.update(developerVideos)
				.set({
					metadata: takenDown
						? takenDownMetadataSql(now)
						: restoredMetadataSql(),
				})
				.where(eq(developerVideos.id, video.id));
		}
		return {
			videoId: video.id,
			appId: video.appId,
			playbackId: video.playbackId,
			takenDown,
			takenDownAt: takenDown
				? (developerVideoTakenDownAt(video.metadata) ?? now.toISOString())
				: null,
			changed,
		};
	});
}

export async function playbackIdIsTakenDown(
	playbackId: string,
): Promise<boolean> {
	const [video] = await db()
		.select({ metadata: developerVideos.metadata })
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.playbackId, playbackId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);
	return video ? developerVideoIsTakenDown(video) : false;
}

const PAGE_PATH = /^\/dev\/([A-Za-z0-9_-]{16,64})(?:\/embed)?\/?$/;

const GONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Video not available</title><style>html,body{margin:0;height:100%;background:#050506;color:#E8ECF4;color-scheme:dark;font-family:system-ui,sans-serif}main{display:grid;min-height:100%;place-items:center;padding:16px 20px;box-sizing:border-box;text-align:center}h1{margin:0;font-size:15px;font-weight:500;line-height:1.3;letter-spacing:-0.01em}</style></head><body><main><h1>${DEVELOPER_VIDEO_UNAVAILABLE}</h1></main></body></html>`;

// A page cannot choose a 410 status in the App Router, so the proxy answers
// for a taken down video before the page renders.
export async function developerVideoGonePage(
	pathname: string,
	method: string,
): Promise<Response | null> {
	if (method !== "GET" && method !== "HEAD") return null;
	const playbackId = PAGE_PATH.exec(pathname)?.[1];
	if (!playbackId) return null;
	try {
		if (!(await playbackIdIsTakenDown(playbackId))) return null;
	} catch (error) {
		console.error("[developer-video] Takedown check failed", error);
		return null;
	}
	return new Response(method === "HEAD" ? null : GONE_PAGE, {
		status: 410,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/html; charset=utf-8",
			"X-Robots-Tag": "noindex",
		},
	});
}
