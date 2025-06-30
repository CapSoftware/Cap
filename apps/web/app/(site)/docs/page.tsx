import { DocsPage } from "@/components/pages/DocsPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation — Cap",
};

export default function App() {
  return <DocsPage />;
}
