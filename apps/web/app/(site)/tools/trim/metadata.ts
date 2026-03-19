import type { Metadata } from "next";
import { trimVideoContent } from "@/components/tools/content";

export const metadata: Metadata = {
	title: trimVideoContent.title,
	description: trimVideoContent.description,
	keywords: trimVideoContent.tags?.join(", "),
	openGraph: {
		title: trimVideoContent.title,
		description: trimVideoContent.description,
		type: "website",
	},
	alternates: {
		canonical: "https://cap.so/tools/trim",
	},
};
