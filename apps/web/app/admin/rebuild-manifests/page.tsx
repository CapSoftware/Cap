import { buildEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { getViewerContext } from "@/lib/messenger/data";
import { RebuildManifestsPanel } from "./rebuild-manifests-panel";

export const maxDuration = 300;

export default async function RebuildManifestsPage() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) notFound();

	return <RebuildManifestsPanel />;
}
