import { testimonials } from "@/data/testimonials";
import {
	createBreadcrumbSchema,
	createFAQSchema,
	createOrganizationSchema,
	createProductSchema,
	createSoftwareApplicationSchema,
	createWebSiteSchema,
} from "@/utils/web-schema";

const homePageFAQs = [
	{
		question: "什么是 Cap？",
		answer:
			"Cap 是一款开源的屏幕录制软件，能够轻松创建精美录像并即时分享，是注重隐私的 Loom 替代方案。",
	},
	{
		question: "Cap 的费用是多少？",
		answer:
			"Cap 提供慷慨的免费方案，包括个人使用的工作室模式和最长 5 分钟的分享链接。专业版每位用户每月仅需 8.16 美元起，不到 Loom 价格的一半。",
	},
	{
		question: "Cap 支持 Windows 和 Mac 吗？",
		answer:
			"支持。Cap 可在 macOS 和 Windows 上使用，并在两个平台提供一致的性能和功能。",
	},
	{
		question: "可以在 Cap 中使用自己的存储空间吗？",
		answer:
			"可以。Cap 支持连接自己的 Google Drive 或 S3 存储和自定义域名，让你完全拥有并控制自己的内容。",
	},
	{
		question: "Cap 与其他屏幕录制工具有何不同？",
		answer:
			"Cap 完全开源、注重隐私，并提供个人免费使用的工作室模式、4K 60 帧录制、内置对话评论以及使用自有存储和域名等特色功能。",
	},
	{
		question: "Cap 支持团队协作吗？",
		answer:
			"支持。Cap 在分享链接中内置对话评论，方便与队友协作并直接收集对录像的反馈。",
	},
];

const createHomePageSchema = () => {
	const schemas = [
		createOrganizationSchema(),
		createWebSiteSchema(),
		createSoftwareApplicationSchema(testimonials),
		createProductSchema(),
		createBreadcrumbSchema([{ name: "首页", url: "https://cap.so" }]),
		createFAQSchema(homePageFAQs),
	];

	return JSON.stringify(schemas);
};

export const HomePageSchema = () => {
	return <script type="application/ld+json">{createHomePageSchema()}</script>;
};
