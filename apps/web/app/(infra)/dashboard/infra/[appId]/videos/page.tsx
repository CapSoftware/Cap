import {
	infraVideoListLimit,
	infraVideoListPage,
} from "@/lib/infra-video-view";
import { ApiGuide, FirstCredit } from "../../_components/get-started";
import { PageHeader } from "../../_components/ui";
import { UploadDrop } from "../../_components/upload-drop";
import {
	getDeveloperAppVideos,
	getInfraProCredit,
	infraPageMetadata,
	requireInfraApp,
} from "../../infra-data";
import { VideosClient } from "./videos-client";

export const generateMetadata = infraPageMetadata("Videos");

export default async function InfraVideosPage({
	params,
	searchParams,
}: {
	params: Promise<{ appId: string }>;
	searchParams: Promise<{
		userId?: string | string[];
		show?: string | string[];
	}>;
}) {
	const [{ appId }, query] = await Promise.all([params, searchParams]);
	const { app } = await requireInfraApp(appId);
	const userId =
		typeof query.userId === "string" && query.userId.trim()
			? query.userId.trim()
			: undefined;

	const limit = infraVideoListLimit(query.show);
	const { rows: videos, ...page } = infraVideoListPage(
		await getDeveloperAppVideos(app.id, { userId, limit: limit + 1 }),
		limit,
	);

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
				<ApiGuide />
			</>
		);
	}

	return (
		<VideosClient
			appId={app.id}
			videos={videos}
			userId={userId ?? ""}
			hasMore={page.hasMore}
			nextLimit={page.nextLimit}
		/>
	);
}
