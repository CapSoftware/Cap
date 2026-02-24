import type { Metadata } from "next";
import { RemoteTeamCollaborationPage } from "@/components/pages/seo/RemoteTeamCollaborationPage";

export const metadata: Metadata = {
	title:
		"Remote Team Collaboration Software: Asynchronous Screen Recording for Distributed Teams",
	description:
		"Enhance your remote team collaboration with Cap's secure, open-source screen recording platform. Save time, improve clarity, and boost productivity across time zones.",
	openGraph: {
		title:
			"Remote Team Collaboration Software: Async Screen Recording for Distributed Teams",
		description:
			"Enhance your remote team collaboration with Cap's secure, open-source screen recording platform. Save time and boost productivity across time zones.",
		url: "https://cap.so/solutions/remote-team-collaboration",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Remote Team Collaboration Software",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Remote Team Collaboration Software | Cap Screen Recorder",
		description:
			"Enhance your remote team collaboration with Cap's secure, open-source screen recording platform. Save time and boost productivity.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/solutions/remote-team-collaboration",
	},
};

export default RemoteTeamCollaborationPage;
