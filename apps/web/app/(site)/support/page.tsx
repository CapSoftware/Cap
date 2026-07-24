import type { Metadata } from "next";
import { SupportPage } from "@/components/pages/SupportPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Support — Cap",
	description:
		"Get help with Cap. Join our Discord community, email support@cap.so, read the docs, or report an issue on GitHub.",
	path: "/support",
	ogTitle: "Get help with Cap",
	ogTag: "Support",
});

export default function App() {
	return <SupportPage />;
}
