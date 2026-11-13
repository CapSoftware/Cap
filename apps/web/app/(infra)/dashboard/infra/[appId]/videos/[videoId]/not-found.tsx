"use client";

import { useParams } from "next/navigation";
import { infraAppPath } from "@/lib/infra-routes";
import { Missing } from "../../../_components/missing";

export default function InfraVideoNotFound() {
	const { appId } = useParams<{ appId: string }>();
	return (
		<Missing
			title="Video not found"
			href={infraAppPath(appId, "videos")}
			action="Back to videos"
		>
			This video does not exist, or it was deleted.
		</Missing>
	);
}
