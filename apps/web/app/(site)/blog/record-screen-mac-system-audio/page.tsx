import type { Metadata } from "next";
import { recordScreenMacContent } from "@/app/../content/blog-content/record-screen-mac-system-audio";
import { BlogTemplate } from "@/components/blog/BlogTemplate";
import { RecordScreenMacStructuredData } from "@/components/blog/RecordScreenMacStructuredData";

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
