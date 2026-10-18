import type { Metadata } from "next";
import { DownloadPage } from "@/components/pages/DownloadPage";
import { buildMarketingMetadata } from "@/lib/og/url";
import { nativeDesktopReleaseIsLive } from "@/utils/native-release";
import { getGitHubReleases } from "@/utils/releases";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Download — Cap",
	path: "/download",
	ogTitle: "Download Cap for macOS, Windows, Linux & Chrome",
	ogTag: "Download",
});

export const revalidate = 60;

export default async function App() {
	const releases = await getGitHubReleases().catch(() => []);
	return (
		<DownloadPage nativeReleaseLive={nativeDesktopReleaseIsLive(releases)} />
	);
}
