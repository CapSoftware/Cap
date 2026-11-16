import type { DeveloperVideoQuery } from "@/lib/developer-video-params";
import {
	DeveloperVideoPage,
	developerVideoMetadata,
} from "../_components/DeveloperVideoPage";

export const dynamic = "force-dynamic";

type Props = {
	params: Promise<{ playbackId: string }>;
	searchParams: Promise<DeveloperVideoQuery>;
};

export async function generateMetadata({ params }: Props) {
	return developerVideoMetadata((await params).playbackId);
}

export default async function DeveloperVideoSharePage({
	params,
	searchParams,
}: Props) {
	return (
		<DeveloperVideoPage
			playbackId={(await params).playbackId}
			variant="share"
			query={await searchParams}
		/>
	);
}
