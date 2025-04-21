import { AboutPage } from "@/components/pages/AboutPage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "About OPAVC — Ontario Provincial Autism Ventures Corporation",
  description: "Learn about OPAVC's mission to support and empower individuals with autism through innovative solutions and community engagement in Ontario.",
};

export default function App() {
  return <AboutPage />;
}
