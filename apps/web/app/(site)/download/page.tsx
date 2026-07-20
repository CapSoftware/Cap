import type { Metadata } from "next";
import { DownloadPage } from "@/components/pages/DownloadPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Download — Cap",
	path: "/download",
	ogTitle: "Download Cap for macOS & Windows",
	ogTag: "Download",
});

export default function App() {
	return <DownloadPage />;
}
