import { buildEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { getViewerContext } from "@/lib/messenger/data";
import {
	getKnowledgeTag,
	isSupermemoryConfigured,
} from "@/lib/messenger/supermemory";
import { AdminPanel } from "./AdminPanel";

export default async function MessengerAdminPage() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) notFound();

	return (
		<AdminPanel
			supermemoryConfigured={isSupermemoryConfigured()}
			knowledgeTag={getKnowledgeTag()}
		/>
	);
}
