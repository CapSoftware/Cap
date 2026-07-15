import type { Metadata } from "next";
import { InstantModePage } from "./InstantModePage";

export const metadata: Metadata = {
	title: "即时模式 - 快速屏幕录制与分享 | Cap",
	description:
		"使用 Cap 云端驱动的即时模式立即录制和分享，并通过自动转写、协作评论、分享链接和团队工作区快速获得反馈。",
	openGraph: {
		title: "即时模式 - 快速屏幕录制与分享 | Cap",
		description:
			"使用 Cap 云端驱动的即时模式立即录制和分享，并通过自动转写、协作评论、分享链接和团队工作区快速获得反馈。",
		url: "https://cap.so/features/instant-mode",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap 即时模式",
			},
		],
		locale: "zh_CN",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "即时模式 - 快速屏幕录制与分享 | Cap",
		description:
			"使用 Cap 云端驱动的即时模式立即录制和分享，并通过自动转写、协作评论、分享链接和团队工作区快速获得反馈。",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return <InstantModePage />;
}
