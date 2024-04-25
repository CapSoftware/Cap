import { UpdatesPage } from "@/components/pages/UpdatesPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Updates — Cap",
};

export default function App() {
  return <UpdatesPage />;
}
