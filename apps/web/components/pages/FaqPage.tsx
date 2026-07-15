"use client";

import Link from "next/link";

interface FaqItem {
	title: string;
	answer: string;
	link?: {
		text: string;
		href: string;
	};
}

const faqContent: FaqItem[] = [
	{
		title: "Cap 适合哪些人？",
		answer:
			"Cap 适合任何需要录制、编辑和分享视频的人。它轻量而强大，帮助创作者、教育工作者、营销人员、开发者和远程团队通过屏幕录像更高效地沟通。",
	},
	{
		title: "费用是多少？",
		answer:
			"Cap 提供个人免费版。按年计费时，每月仅需 8.16 美元即可升级到 Cap 专业版，解锁无限云存储、不限录制时长、自定义域名、高级团队功能、视频密码保护、分析和优先支持。企业还可选择商业许可证和自行托管方案。",
	},
	{
		title: "Cap 支持哪些平台？",
		answer:
			"Cap 支持跨平台运行，可用于 macOS（Apple 芯片和 Intel）与 Windows。建议使用 macOS 13.1 或更高版本，以及 Windows 10 或更高版本。",
	},
	{
		title: "Cap 与 Loom 有何不同？",
		answer:
			"Cap 开源、注重隐私，并让你拥有自己的数据。你可以连接自己的 Google Drive 或自定义 S3 存储桶、自行托管整个平台，并获得更轻快的体验。我们重视设计、用户体验和社区共建，内置 Loom 视频导入器也让迁移更加轻松。",
	},
	{
		title: "可以将 Loom 视频导入 Cap 吗？",
		answer:
			"可以！Cap 专业版内置 Loom 视频导入器，可将现有 Loom 录像无缝迁移到 Cap。只需粘贴 Loom 视频链接，其余工作由 Cap 完成，并将所有内容集中整理。",
	},
	{
		title: "可以自行托管 Cap 吗？",
		answer: "可以！Cap 可部署在你自己的基础设施上，让你完全掌控数据。",
	},
	{
		title: "是否提供商业许可证？",
		answer:
			"提供。希望使用 Cap 桌面应用的企业可以购买商业许可证，其中包含带本地功能的 Cap 录制器和编辑器。专业版方案同样包含桌面应用商业许可证。",
		link: {
			text: "停用许可证",
			href: "/deactivate-license",
		},
	},
	{
		title: "测试期结束后会怎样？",
		answer:
			"即使测试期结束并调整常规价格，早期用户在整个订阅期内仍可保留专享价格，以感谢早期支持者。",
	},
];

export const FaqPage = () => {
	return (
		<div className="py-32 md:py-40 wrapper wrapper-sm">
			<div className="mb-14 text-center page-intro">
				<h1>常见问题</h1>
			</div>
			<div className="mb-10">
				{faqContent.map((section) => {
					return (
						<div key={section.title} className="mx-auto my-8 max-w-2xl">
							<h2 className="mb-2 text-xl">{section.title}</h2>
							<p className="text-lg">{section.answer}</p>
							{section.link && (
								<Link
									href={section.link.href}
									className="inline-block mt-2 text-blue-500 hover:text-blue-600 hover:underline"
								>
									{section.link.text} &rarr;
								</Link>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
};
