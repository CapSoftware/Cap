import { buildEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { getViewerContext } from "@/lib/messenger/data";
import { ReplaceVideoPanel } from "./ReplaceVideoPanel";

export default async function ReplaceVideoPage() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) notFound();

	return <ReplaceVideoPanel />;
}
