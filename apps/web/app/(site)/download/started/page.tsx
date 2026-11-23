import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DownloadStartedPage } from "@/components/pages/DownloadStartedPage";
import { getDownloadTarget } from "@/lib/download";

export const metadata: Metadata = {
	title: "Your download has started | Cap",
	robots: { index: false, follow: false },
};

export default async function DownloadStarted(props: {
	searchParams: Promise<{ platform?: string | string[] }>;
}) {
	const { platform } = await props.searchParams;
	const target = getDownloadTarget(platform);
	if (!target) redirect("/download");
	return <DownloadStartedPage platform={target.key} />;
}
