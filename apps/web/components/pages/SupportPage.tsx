"use client";

import {
	ArrowUpRight,
	BookOpen,
	Github,
	Mail,
	MessageCircle,
} from "lucide-react";
import Link from "next/link";
import { ReadyToGetStarted } from "../ReadyToGetStarted";

type SupportChannel = {
	title: string;
	description: string;
	icon: typeof Mail;
	href: string;
	cta: string;
	isExternal?: boolean;
};

const supportChannels: SupportChannel[] = [
	{
		title: "加入 Discord",
		description:
			"与 Cap 团队和社区实时交流，这是获取帮助、分享反馈和了解最新动态的最快方式。",
		icon: MessageCircle,
		href: "https://discord.gg/y8gdQ3WRN3",
		cta: "打开 Discord",
		isExternal: true,
	},
	{
		title: "邮件支持",
		description: "遇到问题、账单事项或希望私下沟通？发送邮件，我们会尽快回复。",
		icon: Mail,
		href: "mailto:support@cap.so",
		cta: "support@cap.so",
	},
	{
		title: "阅读文档",
		description: "查阅涵盖录制、分享、自行托管等内容的指南、教程和参考资料。",
		icon: BookOpen,
		href: "/docs",
		cta: "浏览文档",
	},
	{
		title: "报告问题",
		description:
			"发现错误或希望提出功能建议？Cap 是开源项目，你可以直接在 GitHub 上创建议题。",
		icon: Github,
		href: "https://github.com/CapSoftware/Cap/issues",
		cta: "创建议题",
		isExternal: true,
	},
];

const quickLinks = [
	{ label: "常见问题", href: "/faq" },
	{ label: "自行托管指南", href: "/self-hosting" },
	{
		label: "系统状态",
		href: "https://cap.openstatus.dev/",
		isExternal: true,
	},
	{ label: "信任中心", href: "https://trust.cap.so", isExternal: true },
	{ label: "下载 Cap", href: "/download" },
];

export const SupportPage = () => {
	return (
		<div className="mt-[120px]">
			<div className="wrapper wrapper-sm">
				<div className="mx-auto max-w-[760px] pt-16 pb-24 md:pt-24 md:pb-32">
					<div className="mb-16 text-center md:mb-20">
						<p className="mb-4 text-sm font-medium tracking-widest uppercase text-gray-9">
							支持
						</p>
						<h1 className="text-[2rem] leading-[2.5rem] md:text-[3.25rem] md:leading-[3.75rem] text-gray-12 mb-6">
							需要什么帮助？
						</h1>
						<p className="mx-auto max-w-[560px] text-lg md:text-xl leading-relaxed text-gray-10">
							无论你遇到困难、心存疑问，还是只想打个招呼，都可以通过以下方式联系
							Cap 团队和社区。
						</p>
					</div>

					<div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
						{supportChannels.map((channel) => {
							const Icon = channel.icon;
							return (
								<Link
									key={channel.title}
									href={channel.href}
									target={channel.isExternal ? "_blank" : undefined}
									rel={channel.isExternal ? "noopener noreferrer" : undefined}
									className="group flex flex-col p-6 rounded-2xl border transition-colors duration-200 border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2"
								>
									<div className="flex justify-center items-center mb-5 rounded-xl size-11 bg-gray-3 text-gray-12">
										<Icon className="size-5" />
									</div>
									<h2 className="mb-2 text-xl text-gray-12">{channel.title}</h2>
									<p className="flex-1 text-[0.9375rem] leading-relaxed text-gray-10">
										{channel.description}
									</p>
									<span className="inline-flex gap-1 items-center mt-5 text-[0.9375rem] font-medium text-gray-12 transition-colors duration-200 group-hover:text-blue-9">
										{channel.cta}
										<ArrowUpRight className="size-4" />
									</span>
								</Link>
							);
						})}
					</div>

					<div className="mt-16 md:mt-20">
						<div className="h-px bg-gray-4" />
						<h2 className="mt-12 mb-5 text-2xl md:text-3xl text-gray-12">
							更多资源
						</h2>
						<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{quickLinks.map((link) => (
								<li key={link.label}>
									<Link
										href={link.href}
										target={link.isExternal ? "_blank" : undefined}
										rel={link.isExternal ? "noopener noreferrer" : undefined}
										className="inline-flex gap-1 items-center text-[1.0625rem] text-gray-11 transition-colors duration-200 hover:text-gray-12"
									>
										{link.label}
										<ArrowUpRight className="size-4 text-gray-9" />
									</Link>
								</li>
							))}
						</ul>
					</div>
				</div>
			</div>

			<ReadyToGetStarted />
		</div>
	);
};
