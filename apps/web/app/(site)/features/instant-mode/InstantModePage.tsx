"use client";

import { Clapperboard, Zap } from "lucide-react";
import { FeaturePage } from "@/components/features/FeaturePage";
import type { FeaturePageConfig } from "@/lib/features/types";

const instantModeConfig: FeaturePageConfig = {
	slug: "instant-mode",
	content: {
		hero: {
			title: "即时模式",
			subtitle: "数秒内完成录制、分享和协作",
			description:
				"由云端驱动的屏幕录制，专为即时分享和团队协作打造。适合快速更新、反馈沟通和异步交流，让团队始终高效推进。",
			primaryCta: "免费下载",
			secondaryCta: "升级到 Cap 专业版",
			features: ["即时分享链接", "录制时同步上传", "实时协作"],
		},
		features: {
			title: "为速度与协作而生",
			description: "即时录制、分享并获取反馈所需的一切功能",
			items: [
				{
					title: "即时分享链接",
					description: "通过链接立即分享录像，观看者可在任意浏览器中即时播放。",
					icon: "share",
				},
				{
					title: "录制时同步上传",
					description:
						"录制过程中在后台同步上传，结束后无需等待导出，即刻获得分享链接。",
					icon: "upload",
				},
				{
					title: "自动转写",
					description:
						"AI 为每段录像生成准确文字稿，便于无障碍访问、搜索和查阅。",
					icon: "transcript",
				},
				{
					title: "协作评论",
					description:
						"通过关联时间戳的评论获取上下文反馈，并围绕录像中的具体时刻展开讨论。",
					icon: "comments",
				},
				{
					title: "团队工作区",
					description:
						"按项目、团队或客户整理录像，与成员共享访问权限，保持协作空间井然有序。",
					icon: "workspace",
				},
				{
					title: "实时通知",
					description:
						"有人观看、评论或与录像互动时立即收到通知，无需反复查看也能掌握动态。",
					icon: "bell",
				},
				{
					title: "浏览器观看",
					description:
						"观看者无需下载。录像可在任意现代浏览器中即时播放，并根据网络自适应串流。",
					icon: "browser",
				},
				{
					title: "快速开始录制",
					description:
						"一键开始录制，无需复杂设置；点击录制，其余工作由 Cap 自动完成。",
					icon: "record",
				},
			],
		},
		useCases: {
			title: "适合快速推进的团队",
			description: "即时模式助力快速沟通和高效反馈循环",
			cases: [
				{
					title: "错误报告与支持",
					description:
						"用画面代替描述。录下问题并立即分享，通过直观上下文更快解决。",
					benefits: [
						"可视化错误记录",
						"即时与支持人员分享",
						"协作排查问题",
						"更快解决问题",
					],
				},
				{
					title: "快速更新与站会",
					description:
						"用简短视频更新代替冗长会议，异步分享进展、阻碍和下一步计划。",
					benefits: [
						"异步沟通",
						"可视化进展更新",
						"跨时区友好",
						"可搜索的历史记录",
					],
				},
				{
					title: "设计与产品反馈",
					description:
						"通过上下文评论和时间戳，获取针对设计、原型和产品功能的具体反馈。",
					benefits: ["时间戳评论", "设计协作", "版本跟踪", "利益相关者评审"],
				},
				{
					title: "客户沟通",
					description:
						"通过快速进展视频让客户随时了解情况，无需安排会议即可收集反馈。",
					benefits: [
						"客户信息透明",
						"可视化进展报告",
						"轻松收集反馈",
						"专业展示",
					],
				},
				{
					title: "知识分享",
					description: "快速记录流程、分享知识，并为团队创建可搜索的视频库。",
					benefits: ["快速编写文档", "可搜索内容", "团队知识库", "轻松入职"],
				},
				{
					title: "代码评审与演示",
					description:
						"通过屏幕录像讲解代码变更、演示功能和复杂逻辑，并获得实时反馈。",
					benefits: ["可视化代码讲解", "功能演示", "实时反馈循环", "异步评审"],
				},
			],
		},
		comparison: {
			title: "即时模式与工作室模式",
			description: "为工作流选择合适的录制模式",
			modes: [
				{
					name: "即时模式",
					description: "适合快速分享与协作",
					features: [
						"即时分享链接",
						"录制时同步上传",
						"快速完成",
						"自动转写",
						"评论和反馈工具",
						"团队协作",
						"免费录制 5 分钟*",
						"浏览器观看",
					],
					bestFor: "快速更新、反馈和团队沟通",
					isPrimary: true,
				},
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
					isPrimary: false,
				},
			],
		},
		workflow: {
			title: "数秒内从录制到反馈",
			description: "即时模式为速度而生，让想法尽快转化为反馈",
			steps: [
				{
					title: "一键录制",
					description: "打开 Cap，点击录制即可捕捉屏幕，无需设置或配置。",
					icon: "play",
				},
				{
					title: "后台上传",
					description:
						"录制时 Cap 会在后台上传视频，并自动生成文字稿和分享链接。",
					icon: "upload",
				},
				{
					title: "即时分享",
					description:
						"停止录制后立即获得分享链接，复制粘贴后团队即可在浏览器中观看。",
					icon: "link",
				},
				{
					title: "实时协作",
					description:
						"实时接收评论、反馈和通知，通过关联时间戳的讨论持续推进沟通。",
					icon: "comments",
				},
			],
		},
		faq: {
			title: "常见问题",
			items: [
				{
					question: "即时模式和工作室模式有什么区别？",
					answer:
						"即时模式由云端驱动，适合快速分享和协作；工作室模式在本地录制，适合专业编辑。快速团队沟通请选择即时模式，精致内容创作请选择工作室模式。",
				},
				{
					question: "即时模式可以免费录制多长时间？",
					answer:
						"免费账户使用即时模式时，每次最长可录制 5 分钟。升级 Cap 专业版可解锁不限录制时长、无限存储和高级协作功能。",
				},
				{
					question: "即时模式中的录像安全吗？",
					answer:
						"安全。所有录像在传输和静态存储时都会加密。你可以控制访问权限并随时删除录像，Cap 专业版还提供密码保护等额外安全功能。",
				},
				{
					question: "观看者可以下载我的录像吗？",
					answer:
						"默认情况下，观看者只能在浏览器中观看。Cap 专业版允许控制下载权限，并为敏感内容添加密码保护。",
				},
				{
					question: "录像处理速度有多快？",
					answer:
						"大多数录像会在停止录制后的数秒内处理完毕并可分享，具体时间取决于录像长度和当前系统负载。",
				},
				{
					question: "即时模式可以离线使用吗？",
					answer:
						"即时模式需要联网进行云端处理和分享。离线录制请使用完全在本地工作的工作室模式。",
				},
				{
					question: "升级到 Cap 专业版后，现有录像会怎样？",
					answer:
						"所有现有录像仍可访问，同时会解锁不限录制时长、高级协作、团队工作区、观看分析和优先支持。",
				},
				{
					question: "可以编辑即时模式创建的录像吗？",
					answer:
						"所有录像都支持修剪等基本编辑。Cap 专业版还提供高级编辑功能，并可下载录像交由外部工具编辑。",
				},
			],
		},
		video: {
			title: "观看即时模式演示",
			iframe: {
				src: "https://cap.so/embed/8cq21vmz12tm1zf",
				title: "观看即时模式演示 - Cap 屏幕录制",
			},
		},
		cta: {
			title: "立即开始录制和分享",
			description:
				"加入数千个使用 Cap 即时模式实现更快沟通和更好协作的团队。免费开始使用，升级即可解锁无限功能。",
			primaryButton: "免费下载",
			secondaryButton: "升级到 Cap 专业版",
		},
	},
	customSections: {
		showVideo: true,
		showComparison: true,
		showWorkflow: true,
	},
};

const instantModeIcons = {
	"instant-mode": (
		<Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />
	),
	"studio-mode": (
		<Clapperboard
			fill="var(--blue-9)"
			className="mb-4 size-8"
			strokeWidth={1.5}
		/>
	),
};

export const InstantModePage = () => {
	return (
		<FeaturePage
			config={instantModeConfig}
			customIcons={instantModeIcons}
			showVideo={true}
		/>
	);
};
