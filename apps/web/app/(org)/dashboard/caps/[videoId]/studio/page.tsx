import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BrowserStudioEditor } from "./BrowserStudioEditor";

export const metadata: Metadata = {
	title: "Studio",
};

export default async function BrowserStudioPage({
	params,
}: {
	params: Promise<{ videoId: string }>;
}) {
	const { videoId } = await params;
	const user = await getCurrentUser();

	if (!user?.id) redirect("/login");

	const [video] = await db()
		.select({
			id: videos.id,
			name: videos.name,
			ownerId: videos.ownerId,
		})
		.from(videos)
		.where(
			and(
				eq(videos.id, Video.VideoId.make(videoId)),
				eq(videos.ownerId, user.id),
			),
		)
		.limit(1);

	if (!video) notFound();

	return (
		<BrowserStudioEditor
			videoId={video.id}
			title={video.name}
			shareUrl={`/s/${video.id}`}
		/>
	);
}
