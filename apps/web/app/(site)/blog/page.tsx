import { UpdatesPage } from "@/components/pages/UpdatesPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog — Cap",
};

export default function App() {
  return <UpdatesPage />;
}
