import type { Metadata } from "next";
import { AboutPage } from "@/components/pages/AboutPage";

export const metadata: Metadata = {
	title: "About Us — Cap",
	description:
		"Learn about Cap's mission to make screen sharing effortless, powerful, and private through our open-source, privacy-first platform.",
};

export default function App() {
	return <AboutPage />;
}
