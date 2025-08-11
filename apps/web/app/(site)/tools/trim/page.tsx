"use client";

import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import { TrimmingTool } from "@/components/tools/TrimmingTool";
import { trimVideoContent } from "@/components/tools/content";

export default function TrimVideoPage() {
  return (
    <ToolsPageTemplate
      content={trimVideoContent}
      toolComponent={<TrimmingTool />}
    />
  );
}
