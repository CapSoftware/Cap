import type { Metadata } from "next";
import { DownloadPage } from "@/components/pages/DownloadPage";
import { buildMarketingMetadata } from "@/lib/og/url";
import { nativeDesktopReleaseIsLive } from "@/utils/native-release";
import { getGitHubReleases } from "@/utils/releases";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Download — Cap",
	path: "/download",
	ogTitle: "Download Cap for macOS, Windows, Linux & Chrome",
	ogTag: "Download",
});

export const revalidate = 60;

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Download", url: "https://cap.so/download" },
]);

const downloadPageSchema = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "WebPage",
			"@id": "https://cap.so/download#webpage",
			url: "https://cap.so/download",
			name: "Download Cap",
			isPartOf: { "@id": "https://cap.so/#website" },
			mainEntity: { "@id": "https://cap.so/#software" },
			inLanguage: "en",
		},
		{
			"@type": "SoftwareApplication",
			"@id": "https://cap.so/#software",
			name: "Cap",
			url: "https://cap.so",
			description: "Cap Desktop is a native app for macOS, Windows and Linux.",
			applicationCategory: "MultimediaApplication",
			operatingSystem: ["macOS", "Windows", "Linux"],
			downloadUrl: "https://cap.so/download",
			publisher: { "@id": "https://cap.so/#organization" },
		},
	],
};

export default async function App() {
	const releases = await getGitHubReleases().catch(() => []);
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(breadcrumbSchema)}
			</script>
			<script type="application/ld+json">
				{JSON.stringify(downloadPageSchema)}
			</script>
			<DownloadPage nativeReleaseLive={nativeDesktopReleaseIsLive(releases)} />
		</>
	);
}
