import { Metadata } from "next";
import { ToolsPageContent } from "../../components/ToolsPageContent";

export const metadata: Metadata = {
  title: "Online Tools | Free Browser-Based Utilities",
  description:
    "Discover Cap's collection of free online tools for file conversion, video editing, and more. All tools run directly in your browser for maximum privacy.",
};

export default function ToolsPage() {
  return <ToolsPageContent />;
}
