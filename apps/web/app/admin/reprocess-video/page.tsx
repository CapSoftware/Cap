import { buildEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { getViewerContext } from "@/lib/messenger/data";
import { ReprocessVideoPanel } from "./ReprocessVideoPanel";

export default async function ReprocessVideoPage() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) notFound();

	return <ReprocessVideoPanel />;
}
