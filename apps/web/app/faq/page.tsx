import { FaqPage } from "@/components/pages/FaqPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ - Cap",
};

export default function App() {
  return <FaqPage />;
}
