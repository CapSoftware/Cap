import type { Metadata } from "next";
import { StudioModePage } from "./StudioModePage";

export const metadata: Metadata = {
	title: "Studio Mode - Professional Screen Recording | Cap",
	description:
		"Create professional-quality screen recordings with Cap Studio Mode. Local recording, 4K 60fps quality, precision editing tools, and complete privacy control.",
	openGraph: {
		title: "Studio Mode - Professional Screen Recording | Cap",
		description:
			"Create professional-quality screen recordings with Cap Studio Mode. Local recording, 4K 60fps quality, precision editing tools, and complete privacy control.",
		url: "https://cap.so/features/studio-mode",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap Studio Mode",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Studio Mode - Professional Screen Recording | Cap",
		description:
			"Create professional-quality screen recordings with Cap Studio Mode. Local recording, 4K 60fps quality, precision editing tools, and complete privacy control.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return <StudioModePage />;
}
