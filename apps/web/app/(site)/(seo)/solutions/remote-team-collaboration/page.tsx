import type { Metadata } from "next";
import { RemoteTeamCollaborationPage } from "@/components/pages/seo/RemoteTeamCollaborationPage";
import { ogImageUrl } from "@/lib/og/url";

const ogImage = ogImageUrl({
	title: "Remote team collaboration with async video",
	tag: "Solutions",
});

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
				url: ogImage,
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
		images: [ogImage],
	},
	alternates: {
		canonical: "https://cap.so/solutions/remote-team-collaboration",
	},
};

export default RemoteTeamCollaborationPage;
