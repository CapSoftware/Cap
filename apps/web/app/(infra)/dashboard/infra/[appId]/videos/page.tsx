import type { Metadata } from "next";
import { ApiGuide, FirstCredit } from "../../_components/get-started";
import { PageHeader } from "../../_components/ui";
import { UploadDrop } from "../../_components/upload-drop";
import {
	getDeveloperAppVideos,
	getInfraProCredit,
	requireInfraApp,
} from "../../infra-data";
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
	const publicKeyValue = publicKey?.fullKey ?? null;

	if (videos.length === 0 && !userId) {
		return (
			<>
				<PageHeader
					title="Videos"
					description="Drop in your first video. Once it has processed you can watch it here and copy the links that play it on your site."
				/>
				<UploadDrop />
				<FirstCredit
					appId={app.id}
					balanceMicroCredits={app.creditAccount?.balanceMicroCredits ?? 0}
					proCredit={await getInfraProCredit()}
				/>
				<ApiGuide
					publicKey={publicKeyValue ?? "cpk_..."}
					isProduction={app.environment === "production"}
				/>
			</>
		);
	}

	return <VideosClient appId={app.id} videos={videos} userId={userId ?? ""} />;
}
