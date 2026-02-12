import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hasCameraRecording } from "@/lib/editor-camera";
import { Editor } from "../components/Editor";
import type { ProjectConfiguration } from "../types/project-config";
import { createDefaultConfig } from "../utils/defaults";

interface EditorPageProps {
	params: Promise<{ videoId: string }>;
}

interface LoadedProjectConfig {
	config: ProjectConfiguration;
	updatedAt: string | null;
}

async function getProjectConfig(
	videoId: string,
	duration: number,
): Promise<LoadedProjectConfig> {
	try {
		const cookieStore = await cookies();
		const response = await fetch(
			`${process.env.NEXT_PUBLIC_WEB_URL || ""}/api/editor/${videoId}`,
			{
				cache: "no-store",
				headers: {
					Cookie: cookieStore.toString(),
				},
			},
		);
		if (response.ok) {
			const data = await response.json();
			if (data.config) {
				return {
					config: data.config as ProjectConfiguration,
					updatedAt:
						typeof data.updatedAt === "string" ? data.updatedAt : null,
				};
			}
		}
	} catch {}
	return { config: createDefaultConfig(duration), updatedAt: null };
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
			id: videos.id,
			ownerId: videos.ownerId,
			bucket: videos.bucket,
			name: videos.name,
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			source: videos.source,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video || video.ownerId !== user.id) {
		redirect("/dashboard");
	}

	const videoDuration = video.duration ?? 0;
	const videoWidth = video.width ?? 1920;
	const videoHeight = video.height ?? 1080;
	const sourceType = (video.source as { type: string } | null)?.type;
	const isWebStudio = sourceType === "webStudio";
	const hasCamera = isWebStudio
		? await hasCameraRecording({
				videoId: video.id,
				ownerId: video.ownerId,
				bucketId: video.bucket,
			})
		: false;

	const videoUrl = `/api/playlist?videoId=${video.id}&videoType=mp4&variant=original`;
	const cameraUrl = hasCamera
		? `/api/playlist?videoId=${video.id}&videoType=camera&variant=original`
		: null;

	const projectData = await getProjectConfig(videoId, videoDuration);
	let initialConfig = projectData.config;

	if (hasCamera && initialConfig.camera?.hide) {
		initialConfig = {
			...initialConfig,
			camera: { ...initialConfig.camera, hide: false },
		};
	}

	const videoData = {
		id: video.id,
		name: video.name ?? "Untitled",
		duration: videoDuration,
		width: videoWidth,
		height: videoHeight,
	};

	return (
		<Editor
			video={videoData}
			videoUrl={videoUrl}
			cameraUrl={cameraUrl}
			initialConfig={initialConfig}
			initialProjectUpdatedAt={projectData.updatedAt}
		/>
	);
}
