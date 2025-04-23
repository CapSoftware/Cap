import { HomePage } from "@/components/pages/HomePage";
import { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function Home() {
  return <HomePage />;
}
