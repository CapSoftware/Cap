import { UpdatesPage } from "@/components/pages/UpdatesPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog — OPAVC",
  description: "Stay updated with the latest news, updates, and insights from OPAVC.",
};

export default function App() {
  return <UpdatesPage />;
}
