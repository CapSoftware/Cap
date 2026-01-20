import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

interface EditorPageProps {
	params: Promise<{ videoId: string }>;
}

export default async function EditorPage(props: EditorPageProps) {
	const params = await props.params;
	const videoId = params.videoId as Video.VideoId;
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			name: videos.name,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video || video.ownerId !== user.id) {
		redirect("/dashboard");
	}

	return (
		<div className="flex flex-1 items-center justify-center">
			<div className="text-center space-y-2">
				<h1 className="text-lg font-semibold text-gray-12">Editor</h1>
				<p className="text-sm text-gray-10">{video.name}</p>
			</div>
		</div>
	);
}
