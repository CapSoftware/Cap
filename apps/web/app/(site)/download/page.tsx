import type { Metadata } from "next";
import { DownloadPage } from "@/components/pages/DownloadPage";

export const metadata: Metadata = {
	title: "下载 — Cap",
};

export default function App() {
	return <DownloadPage />;
}
