import { db } from "@cap/database";
import {
	restoredMetadataSql,
	takenDownMetadataSql,
} from "@cap/database/developer-video-takedown";
import { developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { purgeDeveloperPlaybackCache } from "./developer-video-cache";
import { markDeveloperVideoDeleted } from "./developer-video-delete";
import { purgeDeletedDeveloperVideoNow } from "./developer-video-purge";
import {
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
	const result = await db().transaction(async (tx) => {
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
	if (result?.changed) {
		await purgeDeveloperPlaybackCache({ videoId: result.videoId });
	}
	return result;
}

export type DeveloperVideoStaffDeleteResult = {
	videoId: string;
	appId: string;
	playbackId: string | null;
	alreadyDeleted: boolean;
	filesPurged: boolean;
};

async function findVideo(column: "playbackId" | "id", value: string) {
	const [video] = await db()
		.select({
			id: developerVideos.id,
			appId: developerVideos.appId,
			playbackId: developerVideos.playbackId,
			deletedAt: developerVideos.deletedAt,
		})
		.from(developerVideos)
		.where(eq(developerVideos[column], value))
		.limit(1);
	return video ?? null;
}

// For content that must not stay up. The takedown answers the hosted page at
// once; the delete is the customer's own delete, and purging the files now is
// what stops CDN links already handed out. A video the customer already
// deleted is purged again, so staff can be sure its files are gone.
export async function staffDeleteDeveloperVideo(
	input: string,
	now: Date = new Date(),
): Promise<DeveloperVideoStaffDeleteResult | null> {
	const reference = developerVideoReference(input);
	if (!reference) return null;
	const video =
		(await findVideo("playbackId", reference)) ??
		(await findVideo("id", reference));
	if (!video) return null;

	const alreadyDeleted = video.deletedAt !== null;
	if (!alreadyDeleted) {
		await setDeveloperVideoTakedown(video.id, true, now);
		await markDeveloperVideoDeleted(
			{ appId: video.appId, videoId: video.id },
			now,
		);
	}
	const filesPurged = await purgeDeletedDeveloperVideoNow({
		id: video.id,
		appId: video.appId,
	});
	return {
		videoId: video.id,
		appId: video.appId,
		playbackId: video.playbackId,
		alreadyDeleted,
		filesPurged,
	};
}
