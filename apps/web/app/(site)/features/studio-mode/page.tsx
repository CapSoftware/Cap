import type { Metadata } from "next";
import { StudioModePage } from "./StudioModePage";

export const metadata: Metadata = {
	title: "工作室模式 - 专业屏幕录制 | Cap",
	description:
		"使用 Cap 工作室模式创作专业品质的屏幕录像，支持本地录制、4K 60 帧画质、精确编辑工具和完整隐私控制。",
	openGraph: {
		title: "工作室模式 - 专业屏幕录制 | Cap",
		description:
			"使用 Cap 工作室模式创作专业品质的屏幕录像，支持本地录制、4K 60 帧画质、精确编辑工具和完整隐私控制。",
		url: "https://cap.so/features/studio-mode",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap 工作室模式",
			},
		],
		locale: "zh_CN",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "工作室模式 - 专业屏幕录制 | Cap",
		description:
			"使用 Cap 工作室模式创作专业品质的屏幕录像，支持本地录制、4K 60 帧画质、精确编辑工具和完整隐私控制。",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return <StudioModePage />;
}
