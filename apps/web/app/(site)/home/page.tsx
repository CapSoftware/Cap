import type { Metadata } from "next";
import { HomePage } from "@/components/pages/HomePage";

export const metadata: Metadata = {
	robots: {
		index: false,
		follow: false,
	},
	alternates: {
		canonical: "https://cap.so/",
	},
};

export default async function Home() {
	return <HomePage />;
}
