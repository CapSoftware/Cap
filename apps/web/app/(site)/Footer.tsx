"use client";

import { Logo } from "@cap/ui";
import {
	faDiscord,
	faLinkedinIn,
	faXTwitter,
} from "@fortawesome/free-brands-svg-icons";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";

type FooterLink = {
	label: string;
	href: string;
	isExternal?: boolean;
};

const footerLinks = {
	product: [
		{ label: "博客", href: "/blog" },
		{ label: "文档", href: "/docs" },
		{ label: "价格", href: "/pricing" },
		{ label: "下载", href: "/download" },
		{
			label: "开源",
			href: "https://github.com/CapSoftware/Cap",
			isExternal: true,
		},
		{
			label: "加入社区",
			href: "https://discord.gg/y8gdQ3WRN3",
			isExternal: true,
		},
		{
			label: "开源伙伴",
			href: "/oss-friends",
		},
	] as FooterLink[],
	help: [
		{ label: "关于", href: "/about" },
		{ label: "用户评价", href: "/testimonials" },
		{ label: "常见问题", href: "/faq" },
		{ label: "自托管", href: "/self-hosting" },
		{ label: "支持", href: "/support" },
		{ label: "邮件支持", href: "mailto:hello@cap.so" },
		{ label: "信任中心", href: "https://trust.cap.so" },
		{
			label: "在线支持",
			href: "https://discord.gg/y8gdQ3WRN3",
			isExternal: true,
		},
		{
			label: "系统状态",
			href: "https://cap.openstatus.dev/",
			isExternal: true,
		},
	] as FooterLink[],
	tools: [
		{ label: "WebM 转 MP4", href: "/tools/convert/webm-to-mp4" },
		{ label: "MOV 转 MP4", href: "/tools/convert/mov-to-mp4" },
		{ label: "AVI 转 MP4", href: "/tools/convert/avi-to-mp4" },
		{ label: "MP4 转 GIF", href: "/tools/convert/mp4-to-gif" },
		{ label: "MP4 转 MP3", href: "/tools/convert/mp4-to-mp3" },
		{ label: "MP4 转 WebM", href: "/tools/convert/mp4-to-webm" },
		{ label: "视频速度控制器", href: "/tools/video-speed-controller" },
		{ label: "裁剪视频", href: "/tools/trim" },
	] as FooterLink[],
	useCases: [
		{
			label: "远程团队协作",
			href: "/solutions/remote-team-collaboration",
		},
		{
			label: "员工入职平台",
			href: "/solutions/employee-onboarding-platform",
		},
		{
			label: "每日站会软件",
			href: "/solutions/daily-standup-software",
		},
		{
			label: "在线课堂工具",
			href: "/solutions/online-classroom-tools",
		},
		{
			label: "代理机构",
			href: "/solutions/agencies",
		},
	] as FooterLink[],
	additional: [
		{ label: "Loom 视频导入工具", href: "/loom-alternative" },
		{ label: "从 Loom 迁移", href: "/migrate-from-loom" },
		{ label: "Loom 视频下载工具", href: "/tools/loom-downloader" },
		{ label: "屏幕录制工具", href: "/screen-recorder" },
		{ label: "免费屏幕录制工具", href: "/free-screen-recorder" },
		{ label: "Mac 屏幕录制工具", href: "/screen-recorder-mac" },
		{ label: "Windows 屏幕录制工具", href: "/screen-recorder-windows" },
		{ label: "屏幕录制软件", href: "/screen-recording-software" },
		{
			label: "Chrome 屏幕录制工具",
			href: "/google-chrome-screen-recorder",
		},
		{
			label: "Google 云端硬盘屏幕录制工具",
			href: "/google-drive-screen-recorder",
		},
		{ label: "Cap 与 Loom 对比", href: "/loom-alternative" },
		{ label: "学生优惠", href: "/student-discount" },
	] as FooterLink[],
};

const socialLinks: {
	label: string;
	href: string;
	icon: ComponentProps<typeof FontAwesomeIcon>["icon"];
}[] = [
	{ label: "X (@Cap)", href: "https://x.com/cap", icon: faXTwitter },
	{
		label: "Discord",
		href: "https://discord.gg/y8gdQ3WRN3",
		icon: faDiscord,
	},
	{
		label: "LinkedIn",
		href: "https://www.linkedin.com/company/caprecorder/",
		icon: faLinkedinIn,
	},
];

const complianceBadges: { label: string; content: ReactNode }[] = [
	{
		label: "SOC 2",
		content: (
			<text
				x="22"
				y="25.5"
				textAnchor="middle"
				fontSize="8.5"
				fontWeight="700"
				letterSpacing="0.2"
				className="fill-current"
			>
				SOC 2
			</text>
		),
	},
	{
		label: "HIPAA",
		content: (
			<text
				x="22"
				y="25.5"
				textAnchor="middle"
				fontSize="8"
				fontWeight="700"
				letterSpacing="0.1"
				className="fill-current"
			>
				HIPAA
			</text>
		),
	},
	{
		label: "ISO 27001",
		content: (
			<>
				<text
					x="22"
					y="21"
					textAnchor="middle"
					fontSize="8.5"
					fontWeight="700"
					className="fill-current"
				>
					ISO
				</text>
				<text
					x="22"
					y="29.5"
					textAnchor="middle"
					fontSize="6.5"
					fontWeight="600"
					letterSpacing="0.4"
					className="fill-current"
				>
					27001
				</text>
			</>
		),
	},
];

const ComplianceBadges = () => (
	<div>
		<div className="flex flex-wrap gap-2.5 items-center text-gray-10">
			{complianceBadges.map(({ label, content }) => (
				<Link
					key={label}
					href="https://trust.cap.so"
					target="_blank"
					rel="noopener noreferrer"
					title={`${label} — 认证进行中`}
					aria-label={`${label} 合规认证进行中，查看 Cap 信任中心`}
					className="transition-colors text-gray-9 hover:text-gray-12"
				>
					<svg
						viewBox="0 0 44 44"
						fill="none"
						aria-hidden="true"
						className="size-9"
					>
						<circle cx="22" cy="22" r="21" stroke="currentColor" />
						<circle
							cx="22"
							cy="22"
							r="17.5"
							stroke="currentColor"
							strokeDasharray="1 2.5"
						/>
						{content}
					</svg>
				</Link>
			))}
		</div>
		<p className="mt-2 text-[11px] text-gray-9">认证进行中</p>
	</div>
);

const FooterColumn = ({
	title,
	titleHref,
	links,
}: {
	title: string;
	titleHref?: string;
	links: FooterLink[];
}) => {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div className="border-b border-gray-4 lg:border-none">
			<button
				type="button"
				aria-expanded={isOpen}
				onClick={() => setIsOpen((prev) => !prev)}
				className="flex justify-between items-center py-4 w-full text-lg font-semibold text-left text-gray-12 lg:hidden"
			>
				{title}
				<FontAwesomeIcon
					icon={faChevronDown}
					className={`size-3.5 text-gray-10 transition-transform duration-200 ${
						isOpen ? "rotate-180" : ""
					}`}
				/>
			</button>

			{titleHref ? (
				<Link
					href={titleHref}
					className="hidden pb-2 text-lg font-semibold transition-colors text-gray-12 hover:text-gray-11 lg:block"
				>
					{title}
				</Link>
			) : (
				<h3 className="hidden pb-2 text-lg font-semibold text-gray-12 lg:block">
					{title}
				</h3>
			)}

			<div
				className={`grid transition-[grid-template-rows] duration-200 ease-out lg:grid-rows-[1fr] ${
					isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
				}`}
			>
				<div className="overflow-hidden">
					<ul className="grid grid-cols-1 gap-2 pb-4 lg:pb-0">
						{links.map((link) => (
							<li key={`${link.href}:${link.label}`}>
								<Link
									className="transition-colors text-gray-10 hover:text-gray-12"
									href={link.href}
									target={link.isExternal ? "_blank" : undefined}
								>
									{link.label}
								</Link>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
};

export const Footer = () => {
	return (
		<footer className="overflow-hidden relative border-t border-gray-4">
			<div className="wrapper relative pt-20 pb-10">
				<div
					aria-hidden="true"
					className="absolute bottom-0 left-1/2 w-[700px] -translate-x-1/2 translate-y-2/3 select-none pointer-events-none opacity-[0.05] sm:w-[1000px] lg:w-[1300px]"
				>
					<Logo
						hideLogoName
						viewBoxDimensions="0 0 40 40"
						className="w-full h-auto"
					/>
				</div>

				<div className="relative z-10">
					<div className="flex flex-col gap-12 xl:flex-row xl:gap-16">
						<div className="xl:w-[260px] xl:shrink-0">
							<Logo className="w-[104px] h-auto" />
							<p className="mt-5 max-w-sm text-sm leading-6 text-gray-11">
								开源的 Loom 替代方案。轻量、强大、跨平台，数秒内完成录制与分享。
							</p>
							<div className="flex gap-2.5 items-center mt-6">
								{socialLinks.map((social) => (
									<a
										key={social.href}
										href={social.href}
										target="_blank"
										rel="noopener noreferrer"
										aria-label={social.label}
										className="flex justify-center items-center rounded-full border transition-colors size-9 border-gray-4 text-gray-10 hover:text-gray-12 hover:border-gray-6 hover:bg-gray-3"
									>
										<FontAwesomeIcon icon={social.icon} className="size-4" />
									</a>
								))}
							</div>
						</div>

						<div className="grid flex-1 grid-cols-1 border-t border-gray-4 lg:grid-cols-5 lg:gap-x-8 lg:gap-y-10 lg:border-none">
							<FooterColumn title="产品" links={footerLinks.product} />
							<FooterColumn title="更多链接" links={footerLinks.additional} />
							<FooterColumn title="Cap" links={footerLinks.help} />
							<FooterColumn title="使用场景" links={footerLinks.useCases} />
							<FooterColumn
								title="工具"
								titleHref="/tools"
								links={footerLinks.tools}
							/>
						</div>
					</div>

					<div className="flex flex-col gap-6 pt-8 mt-20 border-t sm:flex-row sm:justify-between sm:items-end border-gray-4">
						<div className="flex flex-col gap-4">
							<ComplianceBadges />
							<p className="text-sm text-gray-9">
								© Cap Software, Inc. {new Date().getFullYear()}.
							</p>
						</div>
						<div className="flex flex-wrap gap-x-8 gap-y-2">
							<a
								className="text-sm transition-colors text-gray-9 hover:text-gray-12"
								href="/terms"
							>
								服务条款
							</a>
							<a
								className="text-sm transition-colors text-gray-9 hover:text-gray-12"
								href="/privacy"
							>
								隐私政策
							</a>
							<a
								className="text-sm transition-colors text-gray-9 hover:text-gray-12"
								href="/dpa"
							>
								数据处理协议
							</a>
						</div>
					</div>
				</div>
			</div>
		</footer>
	);
};
