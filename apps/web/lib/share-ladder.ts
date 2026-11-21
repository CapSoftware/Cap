import { db } from "@cap/database";
import { type ShareLadderRendition, shareLadders } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { discardShareLadder } from "@/lib/share-ladder-discard";
import {
	readShareLadderFlag,
	type ShareLadderFlag,
	shareLadderEnabledFor,
} from "@/lib/share-ladder-flag";
import {
	isShareLadderEligible,
	SHARE_LADDER_MASTER,
	SHARE_LADDER_TRIGGER_VIEWS,
	shareLadderBitsPerSecond,
} from "@/lib/share-ladder-policy";
import { headShareObject } from "@/lib/share-ladder-storage";
import { getVideoViewCount } from "@/lib/video-view-count";
import { buildShareLadderWorkflow } from "@/workflows/build-share-ladder";

const VIEW_CHECK_INTERVAL_MS = 10 * 60 * 1000;
// Longer than a build can take: a day of waiting for the farm plus the job
// deadline. A row older than this lost its workflow and is offered again.
const STALLED_BUILD_MS = 30 * 60 * 60 * 1000;

export type ShareLadderVideo = {
	id: Video.VideoId;
	ownerId: string;
	orgId: string | null;
	bucket: string | null;
	storageIntegrationId: string | null;
	duration: number | null;
	width: number | null;
	height: number | null;
	sourceType: string;
	isScreenshot: boolean;
	hasActiveUpload: boolean;
};

export function shareLadderApplies(video: ShareLadderVideo): boolean {
	return (
		!video.bucket &&
		!video.storageIntegrationId &&
		!video.isScreenshot &&
		!video.hasActiveUpload &&
		(video.sourceType === "desktopMP4" || video.sourceType === "webMP4")
	);
}

async function insertCandidate(video: ShareLadderVideo, fileKey: string) {
	const head = await headShareObject(fileKey);
	if (!head) return;
	const eligible = isShareLadderEligible({
		bytes: head.bytes,
		durationSeconds: video.duration,
		width: video.width,
		height: video.height,
	});
	await db()
		.insert(shareLadders)
		.ignore()
		.values({
			videoId: video.id,
			ownerId: video.ownerId as never,
			state: eligible ? "candidate" : "skipped",
			sourceKey: fileKey,
			sourceEtag: head.etag,
			sourceBytes: head.bytes,
			viewHits: 1,
		});
}

export async function recordShareLadderView(
	video: ShareLadderVideo,
	fileKey: string,
	options: { flag?: ShareLadderFlag } = {},
): Promise<void> {
	if (!shareLadderApplies(video)) return;
	const flag = options.flag ?? (await readShareLadderFlag());
	if (!shareLadderEnabledFor(flag, video)) return;

	const [existing] = await db()
		.select()
		.from(shareLadders)
		.where(eq(shareLadders.videoId, video.id))
		.limit(1);

	if (!existing) {
		await insertCandidate(video, fileKey);
		return;
	}

	if (existing.sourceKey !== fileKey) {
		await discardShareLadder(video.id, "source changed");
		await insertCandidate(video, fileKey);
		return;
	}

	if (
		(existing.state === "queued" || existing.state === "encoding") &&
		existing.updatedAt.getTime() < Date.now() - STALLED_BUILD_MS
	) {
		await db()
			.update(shareLadders)
			.set({ state: "candidate", viewsCheckedAt: null, updatedAt: new Date() })
			.where(
				and(
					eq(shareLadders.videoId, video.id),
					eq(shareLadders.state, existing.state),
					eq(shareLadders.updatedAt, existing.updatedAt),
				),
			);
		return;
	}

	if (existing.state !== "candidate") return;

	await db()
		.update(shareLadders)
		.set({ viewHits: sql`${shareLadders.viewHits} + 1`, updatedAt: new Date() })
		.where(
			and(
				eq(shareLadders.videoId, video.id),
				eq(shareLadders.state, "candidate"),
			),
		);
	if (existing.viewHits + 1 < SHARE_LADDER_TRIGGER_VIEWS) return;

	const now = new Date();
	const [claim] = await db()
		.update(shareLadders)
		.set({ viewsCheckedAt: now })
		.where(
			and(
				eq(shareLadders.videoId, video.id),
				eq(shareLadders.state, "candidate"),
				or(
					isNull(shareLadders.viewsCheckedAt),
					lt(
						shareLadders.viewsCheckedAt,
						new Date(now.getTime() - VIEW_CHECK_INTERVAL_MS),
					),
				),
			),
		);
	if (claim.affectedRows !== 1) return;

	const { count } = await getVideoViewCount(video.id);
	if (count < SHARE_LADDER_TRIGGER_VIEWS) return;

	const [queued] = await db()
		.update(shareLadders)
		.set({ state: "queued", updatedAt: new Date() })
		.where(
			and(
				eq(shareLadders.videoId, video.id),
				eq(shareLadders.state, "candidate"),
				eq(shareLadders.sourceKey, fileKey),
			),
		);
	if (queued.affectedRows !== 1) return;
	try {
		await start(buildShareLadderWorkflow, [{ videoId: video.id }]);
	} catch (error) {
		await db()
			.update(shareLadders)
			.set({ state: "candidate", viewsCheckedAt: null, updatedAt: new Date() })
			.where(
				and(
					eq(shareLadders.videoId, video.id),
					eq(shareLadders.state, "queued"),
				),
			);
		throw error;
	}
}

export type ShareLadderPlaybackRow = {
	outputPrefix: string;
	renditions: ShareLadderRendition[];
	bitsPerSecond: number | null;
};

export async function readReadyShareLadder(
	video: ShareLadderVideo,
	fileKey: string,
	options: { flag?: ShareLadderFlag } = {},
): Promise<ShareLadderPlaybackRow | null> {
	if (!shareLadderApplies(video)) return null;
	const flag = options.flag ?? (await readShareLadderFlag());
	if (!shareLadderEnabledFor(flag, video)) return null;
	const [row] = await db()
		.select({
			state: shareLadders.state,
			sourceKey: shareLadders.sourceKey,
			sourceBytes: shareLadders.sourceBytes,
			outputPrefix: shareLadders.outputPrefix,
			renditions: shareLadders.renditions,
		})
		.from(shareLadders)
		.where(eq(shareLadders.videoId, video.id))
		.limit(1);
	if (
		!row ||
		row.state !== "ready" ||
		row.sourceKey !== fileKey ||
		!row.outputPrefix ||
		!row.renditions?.length
	) {
		return null;
	}
	return {
		outputPrefix: row.outputPrefix,
		renditions: row.renditions,
		bitsPerSecond: shareLadderBitsPerSecond({
			bytes: row.sourceBytes ?? 0,
			durationSeconds: video.duration,
			width: video.width,
			height: video.height,
		}),
	};
}

export function shareLadderMasterKey(outputPrefix: string) {
	return `${outputPrefix}${SHARE_LADDER_MASTER}`;
}
