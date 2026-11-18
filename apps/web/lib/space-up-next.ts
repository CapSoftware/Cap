import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { makeCurrentUserLayer, Spaces } from "@cap/web-backend";
import { Space, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";
import { nextInOrder, spaceVideoOrderFromSettings } from "./space-video-order";
import { getSpaceRootVideoOrder } from "./space-video-order-query";

export type SpaceUpNext = {
	spaceId: string;
	spaceName: string;
	video: { id: Video.VideoId; name: string; duration: number | null };
};

const SPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Only runs when a share page was opened from a Space (`?space=`), and only
// for a signed-in viewer the space policy lets in, so plain share links and
// anonymous viewers never pay for it.
export async function getSpaceUpNext({
	spaceParam,
	videoId,
}: {
	spaceParam: string | string[] | undefined;
	videoId: Video.VideoId;
}): Promise<SpaceUpNext | null> {
	const raw = Array.isArray(spaceParam) ? spaceParam[0] : spaceParam;
	if (!raw || !SPACE_ID_PATTERN.test(raw)) return null;

	const user = await getCurrentUser();
	if (!user) return null;

	const spaceOrOrg = await Effect.flatMap(Spaces, (spaces) =>
		spaces.getSpaceOrOrg(Space.SpaceId.make(raw)),
	).pipe(
		Effect.catchAll(() => Effect.succeed(null)),
		Effect.provide(makeCurrentUserLayer(user)),
		runPromise,
	);
	if (!spaceOrOrg || spaceOrOrg.variant !== "space") return null;
	const { space } = spaceOrOrg;

	const order = await getSpaceRootVideoOrder(
		space.id,
		spaceVideoOrderFromSettings(space.settings),
		{ includeScreenshots: false },
	);
	const nextId = nextInOrder(
		order.map((row) => row.id),
		videoId,
	);
	if (!nextId) return null;

	const [next] = await db()
		.select({ id: videos.id, name: videos.name, duration: videos.duration })
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(nextId)))
		.limit(1);
	if (!next) return null;

	return {
		spaceId: space.id,
		spaceName: space.name,
		video: { id: next.id, name: next.name, duration: next.duration },
	};
}
