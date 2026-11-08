import { buildEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { getViewerContext } from "@/lib/messenger/data";
import { RetryRecordingsPanel } from "./retry-recordings-panel";

export default async function RetryRecordingsPage() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) notFound();

	return <RetryRecordingsPanel />;
}
