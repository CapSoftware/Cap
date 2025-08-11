import { BlogTemplate } from "@/components/blog/BlogTemplate";
import { Metadata } from "next";
import { RecordScreenMacStructuredData } from "@/components/blog/RecordScreenMacStructuredData";
import { recordScreenMacContent } from "@/app/../content/blog-content/record-screen-mac-system-audio";

export const metadata: Metadata = {
  title: recordScreenMacContent.title,
  description: recordScreenMacContent.description,
};

export default function RecordScreenMacPage() {
  return (
    <>
      <RecordScreenMacStructuredData />
      <BlogTemplate content={recordScreenMacContent} />
    </>
  );
}
