import type { Metadata } from "next";
import { buildMarketingMetadata } from "@/lib/og/url";
import { StudioModePage } from "./StudioModePage";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Studio Mode - Professional Screen Recording | Cap",
	description:
		"Create professional-quality screen recordings with Cap Studio Mode. Local recording, 4K 60fps quality, precision editing tools, and complete privacy control.",
	path: "/features/studio-mode",
	ogTitle: "Studio Mode — pro-quality recordings",
	ogDescription:
		"Local recording, 4K 60fps quality, precision editing tools, and complete privacy control.",
	ogTag: "Features",
});

const studioModePageSchema = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "WebPage",
			"@id": "https://cap.so/features/studio-mode#webpage",
			url: "https://cap.so/features/studio-mode",
			name: "Studio Mode",
			description:
				"Studio Mode records to your computer and opens the editor when you stop.",
			isPartOf: { "@id": "https://cap.so/#website" },
			about: { "@id": "https://cap.so/#software" },
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

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(studioModePageSchema).replace(/</g, "\\u003c")}
			</script>
			<StudioModePage />
		</>
	);
}
