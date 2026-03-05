import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDeveloperAppVideos } from "../../../developer-data";
import { VideosClient } from "./VideosClient";

export const metadata: Metadata = {
	title: "Developer Videos — Cap",
};

export default async function VideosPage({
	params,
	searchParams,
}: {
	params: Promise<{ appId: string }>;
	searchParams: Promise<{ userId?: string }>;
}) {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");

	const { appId } = await params;
	const { userId } = await searchParams;

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!app) redirect("/dashboard/developers/apps");

	const videos = await getDeveloperAppVideos(appId, { userId });

	return <VideosClient appId={appId} videos={videos} />;
}
