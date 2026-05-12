import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import {
	getShareableLinkPeriod,
	getShareableLinkUsage,
	toShareableLinkUsageSnapshot,
} from "@cap/web-backend";
import { count, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
	const user = await getCurrentUser();

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	const isPro = userIsPro(user);
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

	const usage = isPro
		? toShareableLinkUsageSnapshot(0, getShareableLinkPeriod().resetAt)
		: await getShareableLinkUsage(db(), user.id);

	if (isPro) {
		return Response.json(
			{
				subscription: true,
				videoLimit: 0,
				videoCount: numberOfVideos[0].count,
				shareableLinkUsage: usage,
			},
			{ status: 200 },
		);
	} else {
		return Response.json(
			{
				subscription: false,
				videoLimit: usage.limit,
				videoCount: numberOfVideos[0].count,
				shareableLinkUsage: usage,
			},
			{ status: 200 },
		);
	}
}
