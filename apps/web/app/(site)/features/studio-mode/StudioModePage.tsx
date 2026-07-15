"use client";

import { Clapperboard, Zap } from "lucide-react";
import { FeaturePage } from "@/components/features/FeaturePage";
import type { FeaturePageConfig } from "@/lib/features/types";

const studioModeConfig: FeaturePageConfig = {
	slug: "studio-mode",
	content: {
		hero: {
			title: "工作室模式",
			subtitle: "为创作者打造的专业屏幕录制",
			description:
				"在本地录制，以工作室级画质输出，并提供精确编辑工具。非常适合需要最高品质录像的内容创作者、教育工作者和专业人士。",
			primaryCta: "免费下载 Cap",
			secondaryCta: "观看演示",
			features: ["4K 60 帧录制", "本地处理", "专业编辑工具"],
		},
		features: {
			title: "为专业内容提供工作室级功能",
			description: "创作精致、专业且吸引观众的录像所需的一切功能",
			items: [
				{
					title: "超高画质录制",
					description:
						"最高支持 4K 分辨率和 60 帧录制，以清晰视频展现作品的每个细节。",
					icon: "video",
				},
				{
					title: "本地处理与隐私",
					description:
						"所有录制和编辑都在设备本地完成；在你主动分享之前，内容不会离开电脑。",
					icon: "shield",
				},
				{
					title: "精确时间轴编辑器",
					description:
						"通过专业时间轴界面精确到帧地编辑、剪切、修剪和排列录像。",
					icon: "edit",
				},
				{
					title: "多摄像头角度",
					description:
						"分别录制屏幕和摄像头，可实时合成，也可在录制后通过编辑器调整布局。",
					icon: "camera",
				},
				{
					title: "自定义背景与品牌",
					description: "添加自定义背景和品牌颜色，创作风格一致的专业内容。",
					icon: "palette",
				},
				{
					title: "高级音频控制",
					description:
						"分别控制麦克风和系统音频的音量，并使用独立音量控制和降噪功能。",
					icon: "microphone",
				},
				{
					title: "智能自动缩放",
					description:
						"录制时自动放大重要内容区域，或在录制后通过编辑器添加缩放效果。",
					icon: "zoom",
				},
				{
					title: "导出多种格式",
					description:
						"创建分享链接，或导出为 MP4、GIF，选择最适合分享需求的格式。",
					icon: "download",
				},
			],
		},
		useCases: {
			title: "适合专业内容创作",
			description: "工作室模式帮助各行各业的创作者制作高质量内容",
			cases: [
				{
					title: "软件教程与演示",
					description:
						"通过高质量屏幕捕捉、清晰音频和专业展示制作完整的软件教程。",
					benefits: ["4K 屏幕捕捉", "多轨音频", "缩放效果", "自定义品牌"],
				},
				{
					title: "教育内容",
					description:
						"通过多摄像头角度、自定义背景和精确编辑制作生动的教学视频。",
					benefits: ["画中画", "背景替换", "时间轴编辑", "章节标记"],
				},
				{
					title: "产品演示",
					description: "通过专业品质录像突出产品功能，赢得潜在客户的信任。",
					benefits: ["专业润色", "品牌一致性", "高质量输出", "自定义布局"],
				},
				{
					title: "培训与入职",
					description: "创建可在组织内复用、更新和分发的完整培训材料。",
					benefits: ["内容可复用", "专业品质", "轻松更新", "品牌一致"],
				},
				{
					title: "内容创作",
					description:
						"以工作室级制作水准创作 YouTube 视频、在线课程和社交媒体内容。",
					benefits: ["创作者专属工具", "高质量输出", "专业编辑", "多种格式"],
				},
				{
					title: "文档与知识分享",
					description: "构建完整的视频文档，便于团队随流程演变查阅和更新。",
					benefits: ["知识沉淀", "轻松分享", "专业展示", "可搜索内容"],
				},
			],
		},
		comparison: {
			title: "工作室模式与即时模式",
			description: "根据需求选择合适的录制模式",
			modes: [
				{
					name: "工作室模式",
					description: "适合专业内容创作",
					features: [
						"本地录制与处理",
						"4K 60 帧画质",
						"专业时间轴编辑器",
						"自定义背景与品牌",
						"导出 MP4、GIF 和链接",
						"高级音频控制",
						"不限录制时长",
						"完整隐私控制",
					],
					bestFor: "教程、课程、产品演示和专业内容",
					isPrimary: true,
				},
				{
					name: "即时模式",
					description: "适合快速分享与协作",
					features: [
						"即时分享链接",
						"云端处理",
						"快速完成",
						"自动转写",
						"评论和反馈工具",
						"团队协作",
						"免费录制 5 分钟",
						"浏览器观看",
					],
					bestFor: "快速更新、反馈和团队沟通",
					isPrimary: false,
				},
			],
		},
		workflow: {
			title: "简化专业工作流",
			description: "从录制到最终导出，工作室模式简化整个内容创作过程",
			steps: [
				{
					title: "设置录制",
					description:
						"选择录制区域、摄像头位置和音频源，配置画质设置和品牌元素。",
					icon: "settings",
				},
				{
					title: "安心录制",
					description:
						"所有内容均以最高画质在本地录制，无需联网、不限文件大小，并完全保护隐私。",
					icon: "record",
				},
				{
					title: "精确编辑",
					description:
						"使用专业时间轴编辑器剪切、修剪和增强录像，添加缩放效果并调整布局。",
					icon: "edit",
				},
				{
					title: "导出与分享",
					description:
						"按偏好的格式和画质导出，上传到所选平台或在本地与团队分享。",
					icon: "share",
				},
			],
		},
		faq: {
			title: "常见问题",
			items: [
				{
					question: "工作室模式和即时模式有什么区别？",
					answer:
						"工作室模式以最高画质在本地录制并提供专业编辑工具，适合内容创作；即时模式录制到云端以便立即分享，适合快速更新和协作。",
				},
				{
					question: "工作室模式支持什么录制画质？",
					answer:
						"工作室模式最高支持 4K 分辨率、60 帧录制，为专业内容创作提供尽可能高的画质。",
				},
				{
					question: "工作室模式有录制时长限制吗？",
					answer: "没有。工作室模式不限制录制时长，只受设备可用存储空间限制。",
				},
				{
					question: "工作室模式需要联网吗？",
					answer:
						"不需要。工作室模式可完全离线使用，所有录制和编辑都在设备本地完成，随时随地均可工作。",
				},
				{
					question: "工作室模式支持自有品牌吗？",
					answer:
						"支持。工作室模式提供完整品牌选项，可添加徽标、自定义背景和品牌颜色，制作风格一致的专业内容。",
				},
				{
					question: "可以导出哪些文件格式？",
					answer:
						"工作室模式支持创建分享链接，或按需求设置画质并导出为 MP4、GIF。",
				},
				{
					question: "工作室模式同时支持 Mac 和 Windows 吗？",
					answer:
						"支持。工作室模式包含在 Cap 桌面应用中，适用于 macOS（Intel 和 Apple 芯片）以及 Windows。",
				},
				{
					question: "工作室模式如何收费？",
					answer:
						"个人使用工作室模式完全免费。商业使用需要桌面许可证；该许可证已包含在 Cap 专业版中，也可单独购买。",
				},
			],
		},
		video: {
			title: "观看工作室模式演示",
			iframe: {
				src: "https://cap.so/embed/qk8gt56e1q1r735",
				title: "工作室模式演示 - Cap 屏幕录制",
			},
		},
		cta: {
			title: "今天就开始创作专业内容",
			description:
				"下载 Cap，亲自体验工作室模式的强大功能，创作令人惊艳、吸引观众的专业品质录像。",
			primaryButton: "免费下载 Cap",
			secondaryButton: "升级到 Cap 专业版",
		},
	},
	customSections: {
		showVideo: true,
		showComparison: true,
		showWorkflow: true,
	},
};

const studioModeIcons = {
	"studio-mode": (
		<Clapperboard
			fill="var(--blue-9)"
			className="mb-4 size-8"
			strokeWidth={1.5}
		/>
	),
	"instant-mode": (
		<Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />
	),
};

export const StudioModePage = () => {
	return (
		<FeaturePage
			config={studioModeConfig}
			customIcons={studioModeIcons}
			showVideo={true}
		/>
	);
};
