import {
	DeveloperVideoPage,
	developerVideoMetadata,
} from "../../_components/DeveloperVideoPage";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ playbackId: string }> };

export async function generateMetadata({ params }: Props) {
	return developerVideoMetadata((await params).playbackId);
}

export default async function DeveloperVideoEmbedPage({ params }: Props) {
	return (
		<DeveloperVideoPage
			playbackId={(await params).playbackId}
			variant="embed"
		/>
	);
}
