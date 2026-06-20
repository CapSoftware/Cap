import type { Metadata } from "next";
import { SupportPage } from "@/components/pages/SupportPage";

export const metadata: Metadata = {
	title: "Support — Cap",
	description:
		"Get help with Cap. Join our Discord community, email support@cap.so, read the docs, or report an issue on GitHub.",
};

export default function App() {
	return <SupportPage />;
}
