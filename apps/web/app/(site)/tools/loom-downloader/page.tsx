import type { Metadata } from "next";
import { LoomDownloader } from "@/components/tools/LoomDownloader";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Loom 视频下载器 — 免费下载并迁移到 Cap | Cap",
	description:
		"使用 Cap 在线 Loom 视频下载器免费下载公开 Loom 视频，并以优惠码 MIGRATE20 享受八折，将整个 Loom 视频库迁移到开源替代方案 Cap。",
	keywords: [
		"loom video downloader",
		"download loom video",
		"loom downloader",
		"save loom video",
		"loom video download free",
		"loom to mp4",
		"download loom recording",
		"loom video saver",
		"free loom downloader",
		"loom download tool",
		"import loom videos",
		"loom video importer",
		"migrate from loom",
		"loom to cap migration",
		"loom alternative",
		"switch from loom",
	],
	openGraph: {
		title: "Loom 视频下载器 — 免费下载并迁移到 Cap",
		description:
			"免费下载公开 Loom 视频，然后使用 MIGRATE20 以八折将整个视频库迁移到开源 Loom 替代方案 Cap。",
		url: "https://cap.so/tools/loom-downloader",
		siteName: "Cap",
		type: "website",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap — 免费 Loom 视频下载器",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "Loom 视频下载器 — 免费下载并迁移到 Cap",
		description:
			"免费下载公开 Loom 视频，然后使用 MIGRATE20 以八折将整个视频库迁移到 Cap。",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/loom-downloader",
	},
};

const pageContent: ToolPageContent = {
	title: "Loom 视频下载器",
	description:
		"将任意公开 Loom 视频下载为 MP4，或跳过逐个下载，使用优惠码 MIGRATE20 以八折将整个 Loom 视频库迁移到 Cap。",
	featuresTitle: "下载 Loom 视频，再将整个视频库迁移到 Cap",
	featuresDescription:
		'Cap 的 Loom 下载器免费、快速且无需设置。当你准备彻底离开 Loom 时，Cap 专业版内置的<a href="/loom-alternative">Loom 视频导入器</a>可一键迁移整个工作区。',
	features: [
		{
			title: "即时下载",
			description: "粘贴 Loom 链接，数秒内获得 MP4，无需等待、排队或处理延迟。",
		},
		{
			title: "无需账户",
			description: "无需注册、登录或邮箱，只需粘贴 Loom 网址即可立即下载视频。",
		},
		{
			title: "完全免费下载",
			description:
				"完全免费且不限下载次数。按需保存 Loom 视频，再迁移到 Cap，告别 Loom 每位用户每月 18 美元的费用。",
		},
		{
			title: "导入整个 Loom 视频库",
			description:
				'Cap 专业版内置<a href="/loom-alternative">Loom 视频导入器</a>，无需手动重新上传即可迁移所有 Loom 录像，包括标题、文字稿和章节。',
		},
		{
			title: "价格仅为 Loom 的一半",
			description:
				"Cap 专业版每位用户每月仅需 8.16 美元起，而 Loom 为 18 美元。结账时使用优惠码 <strong>MIGRATE20</strong>，首年还可再享八折。",
		},
		{
			title: "开源且隐私优先",
			description:
				'Cap 是<a href="/">开源 Loom 替代方案</a>。使用自己的 S3 存储桶和域名，完全拥有视频数据。',
		},
	],
	faqs: [
		{
			question: "如何下载 Loom 视频？",
			answer:
				"将 Loom 视频网址粘贴到上方输入框，然后点击“下载视频”，MP4 文件会自动开始下载。点击任意 Loom 视频的分享按钮即可找到网址。",
		},
		{
			question: "Loom 视频下载器免费吗？",
			answer:
				"完全免费且没有限制，无需注册、没有高级付费层级，也不限制可下载的视频数量。",
		},
		{
			question: "MIGRATE20 是什么，如何使用？",
			answer:
				'<strong>MIGRATE20</strong> 是为从 Loom 迁移的新 Cap 专业版订阅者提供的八折优惠码。在<a href="/pricing">价格页结账</a>时应用，即可在包含 Loom 视频导入器的 Cap 专业版首年享受八折。',
		},
		{
			question: "可以一次将所有 Loom 视频导入 Cap 吗？",
			answer:
				'可以。Cap 专业版内置的<a href="/loom-alternative">Loom 视频导入器</a>会连接 Loom 工作区，一次迁移所有视频、标题、文字稿和章节，无需手动下载后再上传。',
		},
		{
			question: "为什么要从 Loom 迁移到 Cap？",
			answer:
				"Cap 是为重视数据所有权和价格的团队打造的开源 Loom 替代方案。每位用户每月 8.16 美元起，即可获得无限云存储、即时分享链接、AI 字幕、自定义域名和自有 S3 存储桶，而 Loom 每月需 18 美元。使用 MIGRATE20 还可再享八折。",
		},
		{
			question: "可以下载私密 Loom 视频吗？",
			answer:
				"不可以，此工具仅适用于可公开访问的 Loom 视频。如果视频需要密码或设为私密，请联系创建者将其公开或直接分享下载文件。",
		},
		{
			question: "下载的视频是什么格式？",
			answer:
				"所有 Loom 视频均以 MP4 格式下载，几乎兼容所有设备、媒体播放器和视频编辑器。",
		},
		{
			question: "会存储我下载的视频吗？",
			answer:
				"不会。免费下载器会在浏览器中解析公开 Loom 视频，并将 MP4 保存到设备。只有当你选择将视频迁移到 Cap 工作区时，Cap 专业版的 Loom 导入器才会使用 Cap 服务端导入流程。",
		},
		{
			question: "什么是 Cap？",
			answer:
				'Cap 是<a href="/">开源 Loom 替代方案</a>，是一款注重隐私的屏幕录制工具，可即时录制、编辑和分享视频，并提供无限存储、自定义域名和内置 Loom 视频导入器。<a href="/download">免费下载 Cap</a>。',
		},
	],
	cta: {
		title: "准备彻底离开 Loom 了吗？",
		description:
			"无需逐个下载。Cap 专业版一键导入整个 Loom 视频库，价格仅为 Loom 的一半。结账时使用 MIGRATE20，首年还可再享八折。",
		buttonText: "迁移到 Cap 专业版，节省 20%",
		buttonHref:
			"/pricing?promo=MIGRATE20&utm_source=loom-downloader&utm_campaign=migrate20",
		secondaryButtonText: "免费下载 Cap",
		secondaryButtonHref: "/download",
	},
};

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "首页", url: "https://cap.so" },
	{ name: "工具", url: "https://cap.so/tools" },
	{
		name: "Loom 视频下载器",
		url: "https://cap.so/tools/loom-downloader",
	},
]);

export default function LoomDownloaderPage() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(breadcrumbSchema)}
			</script>
			<ToolsPageTemplate
				content={pageContent}
				toolComponent={<LoomDownloader />}
			/>
		</>
	);
}
