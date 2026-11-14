"use client";

import { useParams } from "next/navigation";
import { infraAppPath } from "@/lib/infra-routes";
import { Missing } from "../_components/missing";

export default function InfraAppPageNotFound() {
	const { appId } = useParams<{ appId: string }>();
	return (
		<Missing
			title="Page not found"
			href={infraAppPath(appId, "videos")}
			action="Back to videos"
		>
			There is nothing at this address in this app.
		</Missing>
	);
}
