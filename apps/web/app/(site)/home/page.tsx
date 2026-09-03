import type { Metadata } from "next";
import { HomeTwoPage } from "@/components/pages/HomeTwo";
import { homePageMetadata } from "@/components/pages/HomeTwo/metadata";

export const metadata: Metadata = {
	...homePageMetadata,
	robots: {
		index: false,
		follow: false,
	},
};

export default function Home() {
	return <HomeTwoPage />;
}
