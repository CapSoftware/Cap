import type { Metadata } from "next";
import { FeaturesPage } from "./FeaturesPage";

export const metadata: Metadata = {
	title: "功能 - Cap",
	description:
		"探索 Cap 为屏幕录制、分享和协作提供的全部强大功能，包括 AI 工具和高级编辑能力。",
};

export default function Page() {
	return <FeaturesPage />;
}
