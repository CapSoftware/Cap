import type { Metadata } from "next";
import { SpeedController } from "@/components/tools/SpeedController";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "在线视频速度控制器 – 免费加速或减速视频 | Cap",
	description:
		"免费在线视频速度控制器，在 0.25 倍到 3 倍之间无损调整播放速度。完全在浏览器本地处理，无需上传，充分保护隐私。",
	keywords: [
		"video speed controller",
		"speed up video online",
		"slow down video online",
		"change video playback speed",
		"adjust video speed in browser",
		"video speed changer free",
		"online video speed controller",
	],
	openGraph: {
		title: "在线视频速度控制器 – 免费加速或减速视频 | Cap",
		description:
			"直接在浏览器中将视频播放速度调整为 0.25 倍到 3 倍。免费、私密且无需上传，支持 MP4、WebM、MOV、AVI 和 MKV。",
		url: "https://cap.so/tools/video-speed-controller",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap 视频速度控制器 — 免费在线视频变速工具",
			},
		],
		locale: "zh_CN",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "在线视频速度控制器 – 免费加速或减速视频 | Cap",
		description:
			"直接在浏览器中将视频播放速度调整为 0.25 倍到 3 倍，免费、私密且无需上传。",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/video-speed-controller",
	},
};

const faqs = [
	{
		question: "如何在线更改视频速度？",
		answer:
			"打开 Cap 视频速度控制器，拖放视频文件（或点击浏览），在 0.25 倍到 3 倍之间选择目标速度，然后点击加速或减速视频。整个过程都在浏览器中运行，文件不会离开设备。处理完成后即可预览和下载结果。",
	},
	{
		question: "速度控制器支持哪些视频格式？",
		answer:
			"支持 MP4、WebM、MOV、AVI 和 MKV，也就是现代浏览器可以解码的大多数视频格式。建议使用 Chrome 以获得最佳兼容性和性能。",
	},
	{
		question: "视频速度控制器免费吗？",
		answer:
			"完全免费，不限制处理的视频数量，无水印、无需注册且没有隐藏费用。工具完全在浏览器中免费运行。",
	},
	{
		question: "调整速度会改变视频画质吗？",
		answer:
			"不会。工具会保留原始分辨率和码率，只改变播放速度，不会因重新编码而降低画质。音频音调也会自动校正，在新速度下保持自然。",
	},
	{
		question: "有文件大小限制吗？",
		answer:
			"为确保浏览器内流畅处理，最大支持 500MB。对于更大的文件，建议先修剪出需要的片段，再调整速度。",
	},
	{
		question: "为什么处理需要很长时间？",
		answer:
			"浏览器视频处理依赖设备硬件。较旧的 CPU 或 GPU、性能受限的移动设备，以及很长或高分辨率的视频会花费更多时间。为获得最快速度，请在现代台式机或笔记本上使用 Chrome。",
	},
	{
		question: "支持 iPhone 或 Android 吗？",
		answer:
			"支持移动端现代 Safari、Chrome 和 Firefox，但桌面版 Chrome 的表现最稳定。若在移动端遇到问题，请尝试 Chrome 或 Firefox。",
	},
	{
		question: "需要安装软件吗？",
		answer:
			"不需要。工具完全在浏览器中运行，无需下载、插件或扩展。打开页面即可调整视频速度，所有处理都在设备本地完成，充分保护隐私。",
	},
];

const howToSteps = [
	{
		name: "上传视频文件",
		text: "打开 Cap 视频速度控制器，将视频拖放到上传区域，或点击浏览文件。支持最大 500MB 的 MP4、WebM、MOV、AVI 和 MKV。",
	},
	{
		name: "选择目标速度",
		text: "从 0.25 倍（极慢）到 3 倍（极快）之间选择播放速度。工具会显示预计输出时长，便于了解处理后视频的长度。",
	},
	{
		name: "处理并下载视频",
		text: "点击加速或减速视频。处理完全在浏览器中运行，不会向服务器上传任何内容。完成后预览结果，再点击下载保存变速视频。",
	},
];

const faqStructuredData = {
	"@context": "https://schema.org",
	"@type": "FAQPage",
	mainEntity: faqs.map((faq) => ({
		"@type": "Question",
		name: faq.question,
		acceptedAnswer: {
			"@type": "Answer",
			text: faq.answer,
		},
	})),
};

const howToStructuredData = {
	"@context": "https://schema.org",
	"@type": "HowTo",
	name: "如何在线更改视频速度",
	description:
		"使用 Cap 浏览器速度控制器免费调整任意视频的播放速度，无需上传。",
	step: howToSteps.map((step, index) => ({
		"@type": "HowToStep",
		position: index + 1,
		name: step.name,
		text: step.text,
	})),
	tool: {
		"@type": "HowToTool",
		name: "现代网页浏览器（建议使用 Chrome、Edge 或 Brave）",
	},
};

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "首页", url: "https://cap.so" },
	{ name: "工具", url: "https://cap.so/tools" },
	{
		name: "视频速度控制器",
		url: "https://cap.so/tools/video-speed-controller",
	},
]);

export default function SpeedControllerPage() {
	const pageContent: ToolPageContent = {
		title: "视频速度控制器（0.25 倍–3 倍）",
		description: "直接在浏览器中加速或减速任意视频，免费、私密且无需安装",
		featuresTitle: "为什么使用在线视频速度控制器",
		featuresDescription:
			"快速、免费且私密地调整视频速度，完全在浏览器中运行，无需上传且画质无损。",
		features: [
			{
				title: "完全基于浏览器",
				description:
					"所有处理都在浏览器本地运行，无需上传服务器或排队，文件始终保留在设备上。",
			},
			{
				title: "宽广速度范围（0.25 倍–3 倍）",
				description:
					"分步教程可降至 0.25 倍，快速演示可升至 3 倍。音频音调会自动校正，在任意速度下保持自然。",
			},
			{
				title: "画质无损",
				description:
					"工具会保留原始分辨率和码率，只改变播放速度，不会因重新编码而降低画质。",
			},
			{
				title: "完整隐私保护",
				description:
					"视频文件不会离开设备。与将内容上传到远程服务器的其他在线工具不同，所有处理都在客户端完成。",
			},
			{
				title: "无需注册或安装",
				description:
					"无需下载软件、安装浏览器扩展或创建账户，打开页面即可调整，并可在 Chrome、Edge 和 Brave 中立即使用。",
			},
			{
				title: "支持所有常见格式",
				description:
					"支持最大 500MB 的 MP4、WebM、MOV、AVI 和 MKV 文件，适用于屏幕录像、教程、产品演示等各种视频内容。",
			},
		],
		faqs,
		cta: {
			title: "Cap 是开源 Loom 替代方案",
			description:
				"使用 Cap 录制、编辑和分享视频消息。完全开源且注重隐私，无需调整速度，点击录制即可。",
			buttonText: "免费下载 Cap",
		},
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(breadcrumbSchema),
				}}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(faqStructuredData),
				}}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(howToStructuredData),
				}}
			/>
			<ToolsPageTemplate
				content={pageContent}
				toolComponent={<SpeedController />}
			/>
		</>
	);
}
