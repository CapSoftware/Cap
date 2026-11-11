import type { Metadata } from "next";
import { GetStarted } from "../../_components/get-started";
import { PageHeader } from "../../_components/ui";
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

	if (videos.length === 0 && !userId) {
		return (
			<>
				<PageHeader
					title="Videos"
					description="No videos yet. Create your first one through the API and it shows up here as soon as it exists."
				/>
				<div className="max-w-[640px]">
					<GetStarted
						appId={app.id}
						publicKey={publicKey?.fullKey ?? "cpk_..."}
						isProduction={app.environment === "production"}
						balanceMicroCredits={app.creditAccount?.balanceMicroCredits ?? 0}
					/>
				</div>
			</>
		);
	}

	return <VideosClient appId={app.id} videos={videos} userId={userId ?? ""} />;
}
