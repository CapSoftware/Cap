import { DownloadPage } from "@/components/pages/DownloadPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Download OPAVC — Ontario Provincial Autism Ventures Corporation",
  description: "Download OPAVC's software and tools to support and empower individuals with autism through innovative solutions.",
};

export default function App() {
  return <DownloadPage />;
}
