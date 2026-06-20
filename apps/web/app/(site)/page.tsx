import type { Metadata } from "next";
import { HomePage } from "@/components/pages/HomePage";

export const metadata: Metadata = {
	alternates: {
		canonical: "/",
	},
};

export default function Home() {
	return <HomePage />;
}
