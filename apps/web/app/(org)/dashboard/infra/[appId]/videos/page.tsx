import type { Metadata } from "next";
import { getDeveloperAppVideos, requireInfraApp } from "../../infra-data";
import { VideosClient } from "./videos-client";

export const metadata: Metadata = {
	title: "Videos | Cap Infra",
};

export default async function InfraVideosPage({
	params,
	searchParams,
}: {
	params: Promise<{ appId: string }>;
	searchParams: Promise<{ userId?: string | string[] }>;
}) {
	const [{ appId }, query] = await Promise.all([params, searchParams]);
	const { app } = await requireInfraApp(appId);
	const userId =
		typeof query.userId === "string" && query.userId.trim()
			? query.userId.trim()
			: undefined;

	const videos = await getDeveloperAppVideos(app.id, { userId });
	const publicKey = app.apiKeys.find((k) => k.keyType === "public");

	return (
		<VideosClient
			appId={app.id}
			videos={videos}
			userId={userId ?? ""}
			publicKey={publicKey?.fullKey ?? "cpk_..."}
			isProduction={app.environment === "production"}
		/>
	);
}
