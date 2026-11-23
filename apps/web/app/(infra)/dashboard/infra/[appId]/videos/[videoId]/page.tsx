import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getInfraAppStanding } from "@/lib/infra-standing";
import {
	getDeveloperAppVideo,
	getInfraAccess,
	requireInfraApp,
} from "../../../infra-data";
import { VideoClient } from "./video-client";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ appId: string; videoId: string }>;
}): Promise<Metadata> {
	if ((await getInfraAccess()) === "signed_out") return {};
	const { appId, videoId } = await params;
	const { app } = await requireInfraApp(appId);
	const video = await getDeveloperAppVideo(app.id, videoId);
	return video ? { title: `${video.name} | Cap Infra` } : {};
}

export default async function InfraVideoPage({
	params,
}: {
	params: Promise<{ appId: string; videoId: string }>;
}) {
	const { appId, videoId } = await params;
	const { app } = await requireInfraApp(appId);
	const [video, standing] = await Promise.all([
		getDeveloperAppVideo(app.id, videoId),
		getInfraAppStanding(app.id),
	]);
	if (!video) notFound();

	return (
		<VideoClient
			appId={app.id}
			video={video}
			playbackPaused={standing.state === "paused"}
		/>
	);
}
