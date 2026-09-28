import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";
import { EditorApp, type RecentRecording } from "./editor-app";

export const metadata: Metadata = {
	title: "Editor",
};

export default async function EditorPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/login");
	if (!isWebStudioEnabledForEmail(user.email)) redirect("/dashboard/caps");

	const rows = await db()
		.select({
			id: videos.id,
			name: videos.name,
			createdAt: videos.createdAt,
			duration: videos.duration,
		})
		.from(videos)
		.where(
			and(
				eq(videos.ownerId, user.id),
				eq(videos.isScreenshot, false),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type')) IN ('webMP4', 'desktopMP4')`,
			),
		)
		.orderBy(desc(videos.createdAt))
		.limit(24);

	const recordings: RecentRecording[] = rows.map((row) => ({
		id: row.id,
		name: row.name,
		createdAt: row.createdAt.toISOString(),
		duration: row.duration ?? null,
	}));

	return <EditorApp recordings={recordings} />;
}
