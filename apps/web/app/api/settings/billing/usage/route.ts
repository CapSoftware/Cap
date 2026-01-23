import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { videos } from "@inflight/database/schema";
import { userIsPro } from "@inflight/utils";
import { count, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
	const user = await getCurrentUser();

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	const numberOfVideos = await db()
		.select({ count: count() })
		.from(videos)
		.where(eq(videos.ownerId, user.id));

	if (!numberOfVideos[0]) {
		return Response.json(
			{ error: "Could not fetch video count" },
			{ status: 500 },
		);
	}

	if (userIsPro(user)) {
		return Response.json(
			{
				subscription: true,
				videoLimit: 0,
				videoCount: numberOfVideos[0].count,
			},
			{ status: 200 },
		);
	} else {
		return Response.json(
			{
				subscription: false,
				videoLimit: 25,
				videoCount: numberOfVideos[0].count,
			},
			{ status: 200 },
		);
	}
}
