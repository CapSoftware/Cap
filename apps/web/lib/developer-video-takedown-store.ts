import { db } from "@cap/database";
import {
	restoredMetadataSql,
	takenDownMetadataSql,
} from "@cap/database/developer-video-takedown";
import { developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
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
