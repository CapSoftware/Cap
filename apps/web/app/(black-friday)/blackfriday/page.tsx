import type { Metadata } from "next";
import { BlackFridayPage } from "@/components/pages/blackfriday/BlackFridayPage";

const title = "Cap Friday: 50% off Cap Pro Yearly";
const description =
	"Black Friday at Cap: half price on Cap Pro Yearly with code BLACKFRIDAY. Unlimited recordings, sharing and AI on every video.";

export const metadata: Metadata = {
	title,
	description,
	alternates: { canonical: "/blackfriday" },
	openGraph: {
		title,
		description,
		type: "website",
		url: "/blackfriday",
		siteName: "Cap",
		images: [
			{ url: "/blackfriday/og.jpg", width: 1200, height: 630, alt: title },
		],
	},
	twitter: {
		card: "summary_large_image",
		title,
		description,
		images: ["/blackfriday/og.jpg"],
	},
};

export default function Page() {
	return <BlackFridayPage />;
}
