"use client";

import { trimVideoContent } from "@/components/tools/content";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import { TrimmingTool } from "@/components/tools/TrimmingTool";

export default function TrimVideoPage() {
	return (
		<ToolsPageTemplate
			content={trimVideoContent}
			toolComponent={<TrimmingTool />}
		/>
	);
}
