import { DownloadPage } from "@/components/pages/DownloadPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Download — Cap",
};

export default function App() {
  return <DownloadPage />;
}
