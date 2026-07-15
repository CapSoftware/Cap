"use client";

import { Button } from "@cap/ui";
import {
	faBolt,
	faCamera,
	faChartLine,
	faCheckCircle,
	faClock,
	faCloud,
	faCode,
	faCog,
	faComments,
	faDesktop,
	faDownload,
	faEdit,
	faExpand,
	faGlobe,
	faInfinity,
	faKeyboard,
	faLock,
	faMagic,
	faMobileAlt,
	faPalette,
	faRocket,
	faServer,
	faShareNodes,
	faShieldAlt,
	faUsers,
	faVideo,
	faVolumeUp,
	faWandMagicSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";

interface Feature {
	icon: any;
	title: string;
	description: string;
	category: "recording" | "ai" | "sharing" | "editing" | "platform" | "privacy";
	isPro?: boolean;
	isComingSoon?: boolean;
	size?: "small" | "medium" | "large";
}

const features: Feature[] = [
	{
		icon: faVideo,
		title: "即时模式和工作室模式",
		description: "可选择快速创建分享录像，或使用工作室模式进行专业本地编辑",
		category: "recording",
		size: "medium",
	},
	{
		icon: faRocket,
		title: "4K 60 帧录制",
		description: "最高以 4K 分辨率和每秒 60 帧录制清晰画面",
		category: "recording",
	},
	{
		icon: faCamera,
		title: "合成录制",
		description: "分别录制摄像头和屏幕，并实时渲染为一个视频",
		category: "recording",
	},
	{
		icon: faDesktop,
		title: "多种布局",
		description: "从多种录制布局中选择最适合展示内容的方式",
		category: "recording",
	},
	{
		icon: faPalette,
		title: "自定义品牌",
		description: "添加徽标、品牌颜色和自定义背景",
		category: "recording",
	},
	{
		icon: faBolt,
		title: "极速原生应用",
		description: "通过原生 macOS 和 Windows 应用获得闪电般的性能",
		category: "platform",
	},
	{
		icon: faKeyboard,
		title: "键盘快捷键",
		description: "为各项操作自定义键盘快捷键，提高工作效率",
		category: "recording",
	},
	{
		icon: faExpand,
		title: "智能自动缩放",
		description: "录制过程中自动放大重要内容",
		category: "recording",
	},
	{
		icon: faCog,
		title: "高级光标设置",
		description: "自定义光标大小、样式、动画和运动模糊效果",
		category: "recording",
	},
	{
		icon: faPalette,
		title: "自定义背景",
		description: "可选择纯色、渐变、图片或模糊效果作为背景",
		category: "editing",
	},

	{
		icon: faWandMagicSparkles,
		title: "AI 生成标题",
		description: "自动为录像生成吸引人的标题",
		category: "ai",
		isPro: true,
	},
	{
		icon: faMagic,
		title: "智能摘要",
		description: "即时获得由 AI 生成的录像内容摘要",
		category: "ai",
		isPro: true,
		size: "medium",
	},
	{
		icon: faCheckCircle,
		title: "可点击章节",
		description: "自动生成章节标记，轻松浏览长录像",
		category: "ai",
		isPro: true,
	},
	{
		icon: faComments,
		title: "自动转写",
		description: "为每段录像生成准确的文字稿",
		category: "ai",
		isPro: true,
		size: "medium",
	},
	{
		icon: faEdit,
		title: "自动编辑",
		description: "利用 AI 自动移除静音片段并改善节奏",
		category: "ai",
		isComingSoon: true,
	},
	{
		icon: faVolumeUp,
		title: "降噪",
		description: "高级 AI 降噪，让声音清晰纯净",
		category: "ai",
		isComingSoon: true,
	},

	{
		icon: faCloud,
		title: "无限云存储",
		description: "将所有录像存储在云端，不受容量限制",
		category: "sharing",
		isPro: true,
		size: "medium",
	},
	{
		icon: faShareNodes,
		title: "即时分享链接",
		description: "通过简单链接即时分享录像，无需下载",
		category: "sharing",
	},
	{
		icon: faLock,
		title: "密码保护",
		description: "使用密码保护敏感录像",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faChartLine,
		title: "观看分析",
		description: "跟踪录像的观看次数、互动情况和观看时长",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faUsers,
		title: "团队工作区",
		description: "在井然有序的工作区中与团队协作",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faComments,
		title: "对话评论",
		description: "通过关联时间戳的评论展开上下文讨论",
		category: "sharing",
	},
	{
		icon: faGlobe,
		title: "自定义域名",
		description: "使用自己的域名分享录像（cap.yourdomain.com）",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faCode,
		title: "嵌入支持",
		description: "使用可自定义播放器将录像嵌入任意位置",
		category: "sharing",
	},

	{
		icon: faServer,
		title: "使用自有存储",
		description: "连接自己的 Google Drive 或 S3 存储桶，完全拥有数据",
		category: "privacy",
		isPro: true,
	},
	{
		icon: faShieldAlt,
		title: "本地录制",
		description: "使用 Cap 工作室模式在本地录制和存储，数据不会离开设备",
		category: "privacy",
		size: "medium",
	},
	{
		icon: faCode,
		title: "100% 开源",
		description: "代码完全透明且可审计，你可以放心使用并参与贡献",
		category: "privacy",
		size: "medium",
	},
	{
		icon: faServer,
		title: "自行托管",
		description: "在自己的基础设施上部署 Cap，获得完全控制权",
		category: "privacy",
	},

	{
		icon: faDownload,
		title: "Loom 视频导入器",
		description:
			"从 Loom 迁移？可将现有 Loom 录像直接导入 Cap，集中管理所有内容",
		category: "platform",
		size: "medium",
	},
	{
		icon: faMobileAlt,
		title: "跨平台",
		description: "提供适用于 macOS（Apple 芯片和 Intel）及 Windows 的原生应用",
		category: "platform",
		size: "medium",
	},

	{
		icon: faClock,
		title: "时间轴编辑器",
		description: "专业时间轴编辑，精确到每一帧",
		category: "editing",
		size: "medium",
	},
	{
		icon: faEdit,
		title: "分割与修剪",
		description: "轻松剪切、分割和修剪录像",
		category: "editing",
	},
	{
		icon: faDownload,
		title: "导出多种格式",
		description: "导出为 MP4、WebM、MOV、GIF 等格式",
		category: "editing",
	},
	{
		icon: faClock,
		title: "速度控制",
		description: "在 0.25 倍到 3 倍之间调整播放速度",
		category: "editing",
	},
	{
		icon: faInfinity,
		title: "无水印",
		description: "录像完全属于你，绝不会添加 Cap 水印",
		category: "editing",
	},

	{
		icon: faChartLine,
		title: "性能洞察",
		description: "详细分析录制性能和系统资源使用情况",
		category: "platform",
		isComingSoon: true,
	},
	{
		icon: faServer,
		title: "Webhook 和 API",
		description: "通过 Webhook 和 API 访问将 Cap 集成到工作流",
		category: "platform",
		isPro: true,
		isComingSoon: true,
		size: "medium",
	},
	{
		icon: faWandMagicSparkles,
		title: "AI 视频搜索",
		description: "使用自然语言搜索录像内容",
		category: "ai",
		isPro: true,
		isComingSoon: true,
	},
];

const categoryColors = {
	recording: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	ai: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	sharing: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	editing: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	platform: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	privacy: "bg-gray-1 dark:bg-gray-2 border-gray-3",
};

const categoryIcons = {
	recording: { icon: faVideo, color: "text-gray-11" },
	ai: { icon: faWandMagicSparkles, color: "text-gray-11" },
	sharing: { icon: faShareNodes, color: "text-gray-11" },
	editing: { icon: faEdit, color: "text-gray-11" },
	platform: { icon: faDesktop, color: "text-gray-11" },
	privacy: { icon: faShieldAlt, color: "text-gray-11" },
};

export const FeaturesPage = () => {
	return (
		<div className="min-h-screen">
			<div className="relative z-10 px-5 pt-32 pb-20 w-full">
				<div className="mx-auto text-center wrapper wrapper-sm">
					<h1 className="text-[2rem] font-medium leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 mb-4">
						专为以下用户打造的屏幕录制工具
						<br />
						<span className="text-gray-11">团队与创作者</span>
					</h1>
					<p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-gray-10">
						无论你是独立创作者还是全球团队，Cap 都能随需求扩展。以 4K
						录制、顺畅协作、保持品牌一致并更快发布内容，同时始终掌控自己的数据。
					</p>

					<div className="flex flex-col justify-center items-center space-y-2 sm:flex-row sm:space-y-0 sm:space-x-2">
						<Button
							href="/download"
							variant="primary"
							size="lg"
							className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
						>
							免费下载 Cap
						</Button>
						<Button
							href="/pricing"
							variant="blue"
							size="lg"
							className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
						>
							升级到 Cap 专业版
						</Button>
					</div>
				</div>
			</div>

			<div className="pb-32 wrapper">
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-[minmax(200px,_auto)] grid-flow-dense">
					{features.map((feature, index) => {
						const sizeClasses = {
							small: "col-span-1",
							medium: "col-span-1 md:col-span-2",
							large: "col-span-1 md:col-span-2 lg:col-span-2",
						};

						return (
							<div
								key={index}
								className={`
                  ${sizeClasses[feature.size || "small"]}
                  group relative overflow-hidden rounded-xl border p-6
                  ${categoryColors[feature.category]}
                  hover:border-gray-5 transition-all duration-200
                  ${feature.isComingSoon ? "opacity-75" : ""}
                `}
							>
								<div
									className={`
                  w-12 h-12 rounded-lg flex items-center justify-center mb-4
                  bg-gray-2 dark:bg-gray-3
                  ${categoryIcons[feature.category].color}
                `}
								>
									<FontAwesomeIcon icon={feature.icon} className="w-6 h-6" />
								</div>

								<h3 className="mb-2 text-lg font-semibold text-gray-12">
									{feature.title}
									{feature.isPro && (
										<Link
											href="/pricing"
											className="inline-flex items-center px-2 py-1 ml-2 text-xs font-medium text-white bg-gradient-to-br from-blue-400 to-blue-600 rounded-full transition-all duration-200 hover:from-blue-500 hover:to-blue-700"
										>
											Cap Pro
										</Link>
									)}
									{feature.isComingSoon && (
										<span className="px-2 py-1 ml-2 text-xs font-medium rounded-full bg-gray-3 text-gray-10">
											即将推出
										</span>
									)}
								</h3>
								<p className="text-sm leading-relaxed text-gray-11">
									{feature.description}
								</p>

								<div className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100">
									<FontAwesomeIcon
										icon={categoryIcons[feature.category].icon}
										className={`w-4 h-4 ${
											categoryIcons[feature.category].color
										} opacity-50`}
									/>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			<div className="py-32 bg-gray-2 md:py-40">
				<div className="text-center wrapper">
					<h2 className="mb-4 text-3xl font-medium">准备开始了吗？</h2>
					<p className="mx-auto mb-8 max-w-2xl text-lg text-gray-10">
						加入数千名用户，使用 Cap 创作更出色的录像。
					</p>
					<div className="flex flex-col gap-4 justify-center sm:flex-row">
						<Button
							href="/download"
							variant="primary"
							size="lg"
							className="font-medium"
						>
							免费下载 Cap
						</Button>
						<Button
							href="/pricing"
							variant="white"
							size="lg"
							className="font-medium"
						>
							比较方案
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
};
