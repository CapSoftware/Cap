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

export default function Page() {
	return <StudioModePage />;
}
