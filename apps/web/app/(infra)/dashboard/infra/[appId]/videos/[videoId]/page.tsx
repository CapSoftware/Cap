import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDeveloperAppVideo, requireInfraApp } from "../../../infra-data";
import { VideoClient } from "./video-client";

export const metadata: Metadata = {
	title: "Video | Cap Infra",
};

export default async function InfraVideoPage({
	params,
}: {
	params: Promise<{ appId: string; videoId: string }>;
}) {
	const { appId, videoId } = await params;
	const { app } = await requireInfraApp(appId);
	const video = await getDeveloperAppVideo(app.id, videoId);
	if (!video) notFound();

	return <VideoClient appId={app.id} video={video} />;
}
