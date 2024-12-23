import { CareersPage } from "@/components/pages/CareersPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Careers — Cap",
  description:
    "Join the Cap team and help build the future of screen recording software.",
};

export default function Page() {
  return <CareersPage />;
}
