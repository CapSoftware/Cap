"use client";

import { Button } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import {
	BookOpen,
	Check,
	Copy,
	FileText,
	Globe,
	Link2,
	MessageCircle,
	Pause,
	Play,
	Sparkles,
	Upload,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import UpgradeToPro from "../_components/UpgradeToPro";

const instantFeatures = [
	{
		icon: <Link2 className="size-5" />,
		title: "即时链接",
		description: "立即获得可分享网址",
	},
	{
		icon: <Upload className="size-5" />,
		title: "后台上传",
		description: "录制时同步上传",
	},
	{
		icon: <FileText className="size-5" />,
		title: "自动转写",
		description: "AI 生成字幕",
	},
	{
		icon: <Sparkles className="size-5" />,
		title: "AI 摘要",
		description: "自动生成标题和说明",
	},
	{
		icon: <BookOpen className="size-5" />,
		title: "智能章节",
		description: "自动划分时间轴",
	},
	{
		icon: <Globe className="size-5" />,
		title: "浏览器观看",
		description: "无需下载",
	},
];

const EMOJIS = ["😂", "😍", "😮", "🙌", "👍", "👎"] as const;

interface FloatingEmoji {
	id: number;
	emoji: string;
	x: number;
}

const TABS = ["activity", "summary", "transcript"] as const;
type TabKey = (typeof TABS)[number];

const featureContainerVariants = {
	hidden: {},
	visible: {
		transition: {
			staggerChildren: 0.07,
		},
	},
};

const featureItemVariants = {
	hidden: { opacity: 0, y: 20, scale: 0.97 },
	visible: {
		opacity: 1,
		y: 0,
		scale: 1,
		transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] },
	},
};

const formatTime = (seconds: number) => {
	const safe = Number.isFinite(seconds) ? seconds : 0;
	const m = Math.floor(safe / 60);
	const s = Math.floor(safe % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
};

const MockSharePage = () => {
	const [emojiCounts, setEmojiCounts] = useState<Record<string, number>>({});
	const [floatingEmojis, setFloatingEmojis] = useState<FloatingEmoji[]>([]);
	const [linkCopied, setLinkCopied] = useState(false);
	const [activeTab, setActiveTab] = useState<TabKey>("activity");
	const [showCommentInput, setShowCommentInput] = useState(false);
	const [activeChapter, setActiveChapter] = useState<number | null>(null);
	const [tabInteracted, setTabInteracted] = useState(false);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);

	const videoRef = useRef<HTMLVideoElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const videoLoadedRef = useRef(false);
	const userPausedRef = useRef(false);

	useEffect(() => {
		const container = containerRef.current;
		const video = videoRef.current;
		if (!container || !video) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) {
					if (!videoLoadedRef.current) {
						video.src = "/illustrations/homepage-animation.mp4";
						videoLoadedRef.current = true;
					}
					if (!userPausedRef.current) {
						video.play().catch(() => {});
						setIsPlaying(true);
					}
				} else {
					video.pause();
					setIsPlaying(false);
				}
			},
			{ rootMargin: "200px" },
		);

		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (tabInteracted) return;
		let index = 0;
		const interval = setInterval(() => {
			index = (index + 1) % TABS.length;
			const nextTab = TABS[index];
			if (nextTab) {
				setActiveTab(nextTab);
			}
		}, 3000);
		return () => clearInterval(interval);
	}, [tabInteracted]);

	const handleEmojiClick = useCallback((emoji: string, index: number) => {
		setEmojiCounts((prev) => ({
			...prev,
			[emoji]: (prev[emoji] || 0) + 1,
		}));

		const id = Date.now() + index;
		const x = (Math.random() - 0.5) * 40;
		setFloatingEmojis((prev) => [...prev, { id, emoji, x }]);

		setTimeout(() => {
			setFloatingEmojis((prev) => prev.filter((e) => e.id !== id));
		}, 800);
	}, []);

	const handleCopyLink = useCallback(() => {
		setLinkCopied(true);
		setTimeout(() => setLinkCopied(false), 2000);
	}, []);

	const handleTabClick = useCallback((tab: TabKey) => {
		setTabInteracted(true);
		setActiveTab(tab);
	}, []);

	const handlePlayPause = useCallback(() => {
		const video = videoRef.current;
		if (!video) return;
		if (video.paused) {
			video.play().catch(() => {});
			setIsPlaying(true);
			userPausedRef.current = false;
		} else {
			video.pause();
			setIsPlaying(false);
			userPausedRef.current = true;
		}
	}, []);

	const handleTimeUpdate = useCallback(() => {
		const v = videoRef.current;
		if (v?.duration) {
			setProgress((v.currentTime / v.duration) * 100);
		}
	}, []);

	return (
		<div ref={containerRef} className="select-none bg-gray-2">
			<motion.div
				className="px-4 md:px-6 pt-4 md:pt-6"
				initial={{ opacity: 0, y: 10 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true }}
				transition={{ duration: 0.4, delay: 0.2 }}
			>
				<h3 className="text-sm md:text-lg font-medium text-gray-12">
					如何构建 React 组件
				</h3>
				<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-2">
					<div className="flex items-center gap-2">
						<div className="w-6 h-6 md:w-7 md:h-7 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 shrink-0" />
						<div className="flex flex-col">
							<span className="text-[11px] md:text-xs text-gray-12 font-medium">
								张三
							</span>
							<span className="text-[10px] md:text-[11px] text-gray-10">
								2 分钟前
							</span>
						</div>
					</div>
					<motion.button
						type="button"
						className="flex items-center gap-1.5 px-2.5 py-1 md:px-3 md:py-1.5 rounded-lg border border-gray-5 bg-white text-[10px] md:text-xs text-gray-11 font-medium w-fit cursor-pointer transition-colors hover:bg-gray-2"
						onClick={handleCopyLink}
						whileTap={{ scale: 0.95 }}
					>
						{linkCopied ? (
							<>
								<Check className="size-3 text-green-500" />
								<span className="text-green-600">已复制！</span>
							</>
						) : (
							<>
								cap.link/m4k92x
								<Copy className="size-3 text-gray-9" />
							</>
						)}
					</motion.button>
				</div>
			</motion.div>

			<motion.div
				className="flex flex-col lg:flex-row gap-3 md:gap-4 px-4 md:px-6 mt-3 md:mt-4"
				initial={{ opacity: 0, y: 15 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true }}
				transition={{ duration: 0.5, delay: 0.3 }}
			>
				<div className="flex-1">
					<div className="overflow-hidden relative bg-gradient-to-br from-neutral-100 to-neutral-200 rounded-xl md:rounded-2xl border border-gray-5 aspect-video group w-full block">
						<video
							ref={videoRef}
							className="absolute inset-0 w-full h-full object-cover"
							muted
							playsInline
							loop
							preload="none"
							tabIndex={-1}
							onTimeUpdate={handleTimeUpdate}
						/>

						<button
							type="button"
							className="absolute inset-0 z-[5] cursor-pointer bg-transparent"
							onClick={handlePlayPause}
						/>

						<AnimatePresence>
							{!isPlaying && (
								<motion.div
									className="absolute inset-0 flex items-center justify-center bg-black/20 z-10 pointer-events-none"
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.15 }}
								>
									<motion.div
										className="w-10 h-10 md:w-14 md:h-14 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-lg"
										initial={{ scale: 0.8 }}
										animate={{ scale: 1 }}
										exit={{ scale: 0.8 }}
										transition={{
											type: "spring",
											stiffness: 300,
											damping: 25,
										}}
									>
										<Play
											className="size-4 md:size-6 text-gray-12 ml-0.5"
											fill="currentColor"
										/>
									</motion.div>
								</motion.div>
							)}
						</AnimatePresence>

						<div
							className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-200 ${
								isPlaying ? "opacity-0 group-hover:opacity-100" : "opacity-100"
							}`}
						>
							<div className="flex items-center gap-1.5 px-2 md:px-3 py-1.5 md:py-2 bg-gradient-to-t from-black/60 to-transparent">
								<button
									type="button"
									className="shrink-0 cursor-pointer"
									onClick={handlePlayPause}
								>
									{isPlaying ? (
										<Pause
											className="size-3 md:size-4 text-white"
											fill="white"
										/>
									) : (
										<Play
											className="size-3 md:size-4 text-white ml-px"
											fill="white"
										/>
									)}
								</button>
								<div className="flex-1 h-0.5 md:h-1 rounded-full bg-white/30 relative overflow-hidden">
									<div
										className="absolute left-0 top-0 h-full rounded-full bg-white/80"
										style={{ width: `${progress}%` }}
									/>
								</div>
								<span className="text-[7px] md:text-[9px] text-white/70 font-mono shrink-0">
									{formatTime(videoRef.current?.currentTime || 0)} /{" "}
									{formatTime(videoRef.current?.duration || 0)}
								</span>
							</div>
						</div>
					</div>
				</div>

				<div className="hidden lg:flex flex-col w-56 xl:w-64 bg-white rounded-xl md:rounded-2xl border border-gray-5 overflow-hidden">
					<div className="flex border-b border-gray-4">
						{(
							[
								["activity", "动态"],
								["summary", "摘要"],
								["transcript", "文字稿"],
							] as const
						).map(([key, label]) => (
							<button
								key={key}
								type="button"
								className={`flex-1 px-3 py-2 text-[10px] font-medium cursor-pointer transition-colors ${
									activeTab === key
										? "text-gray-12 border-b-2 border-blue-500"
										: "text-gray-9 hover:text-gray-11"
								}`}
								onClick={() => handleTabClick(key)}
							>
								{label}
							</button>
						))}
					</div>
					<div className="flex-1 p-3 overflow-hidden">
						<AnimatePresence mode="wait">
							{activeTab === "activity" && (
								<motion.div
									key="activity"
									className="space-y-3"
									initial={{ opacity: 0, x: -8 }}
									animate={{ opacity: 1, x: 0 }}
									exit={{ opacity: 0, x: 8 }}
									transition={{ duration: 0.15 }}
								>
									<div className="flex items-start gap-2">
										<div className="w-5 h-5 rounded-full bg-green-100 shrink-0 mt-0.5" />
										<div>
											<span className="text-[10px] font-medium text-gray-12">
												Sarah M.
											</span>
											<p className="text-[9px] text-gray-10 mt-0.5">
												这真的很有帮助，谢谢！
											</p>
										</div>
									</div>
									<div className="flex items-start gap-2">
										<div className="w-5 h-5 rounded-full bg-amber-100 shrink-0 mt-0.5" />
										<div>
											<span className="text-[10px] font-medium text-gray-12">
												Mike R.
											</span>
											<p className="text-[9px] text-gray-10 mt-0.5">
												讲解得很清楚
											</p>
										</div>
									</div>
									<div className="flex items-start gap-2">
										<div className="w-5 h-5 rounded-full bg-purple-100 shrink-0 mt-0.5" />
										<div>
											<span className="text-[10px] font-medium text-gray-12">
												Alex K.
											</span>
											<p className="text-[9px] text-gray-10 mt-0.5">
												可以分享代码仓库吗？
											</p>
										</div>
									</div>
								</motion.div>
							)}
							{activeTab === "summary" && (
								<motion.div
									key="summary"
									initial={{ opacity: 0, x: -8 }}
									animate={{ opacity: 1, x: 0 }}
									exit={{ opacity: 0, x: 8 }}
									transition={{ duration: 0.15 }}
								>
									<span className="text-[9px] font-medium text-gray-8 flex items-center gap-1">
										<Sparkles className="size-2.5" /> 由 Cap AI 生成
									</span>
									<p className="text-[9px] text-gray-11 mt-1.5 leading-relaxed">
										从零构建可复用 React
										组件的分步指南，涵盖属性、状态管理和测试最佳实践。
									</p>
								</motion.div>
							)}
							{activeTab === "transcript" && (
								<motion.div
									key="transcript"
									className="space-y-2"
									initial={{ opacity: 0, x: -8 }}
									animate={{ opacity: 1, x: 0 }}
									exit={{ opacity: 0, x: 8 }}
									transition={{ duration: 0.15 }}
								>
									<div className="flex gap-2">
										<span className="text-[9px] text-blue-500 shrink-0 w-6">
											0:00
										</span>
										<span className="text-[9px] text-gray-11">
											大家好，今天我们来构建一个 React 组件……
										</span>
									</div>
									<div className="flex gap-2">
										<span className="text-[9px] text-blue-500 shrink-0 w-6">
											0:12
										</span>
										<span className="text-[9px] text-gray-11">
											首先，设置项目结构并安装依赖……
										</span>
									</div>
									<div className="flex gap-2">
										<span className="text-[9px] text-blue-500 shrink-0 w-6">
											0:28
										</span>
										<span className="text-[9px] text-gray-11">
											现在创建组件文件并定义属性……
										</span>
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				</div>
			</motion.div>

			<motion.div
				className="flex justify-center px-4 md:px-6 mt-3 md:mt-4"
				initial={{ opacity: 0, y: 10 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true }}
				transition={{ duration: 0.4, delay: 0.4 }}
			>
				<div className="relative flex items-center gap-1 md:gap-1.5 p-1.5 md:p-2 bg-white rounded-full border border-gray-5 w-fit">
					{EMOJIS.map((emoji, i) => (
						<motion.button
							key={emoji}
							type="button"
							className="relative flex items-center justify-center size-6 md:size-8 text-xs md:text-base rounded-full hover:bg-gray-2 cursor-pointer font-emoji"
							onClick={() => handleEmojiClick(emoji, i)}
							whileTap={{ scale: 1.4 }}
							transition={{
								type: "spring",
								stiffness: 500,
								damping: 15,
							}}
						>
							{emoji}
							<AnimatePresence>
								{(emojiCounts[emoji] || 0) > 0 && (
									<motion.span
										className="absolute -top-1 -right-1 bg-blue-500 text-white text-[7px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5"
										initial={{ scale: 0 }}
										animate={{ scale: 1 }}
										key={emojiCounts[emoji]}
									>
										{emojiCounts[emoji]}
									</motion.span>
								)}
							</AnimatePresence>
						</motion.button>
					))}

					<AnimatePresence>
						{floatingEmojis.map((fe) => (
							<motion.span
								key={fe.id}
								className="absolute text-lg md:text-xl pointer-events-none font-emoji"
								initial={{ opacity: 1, y: 0, x: fe.x }}
								animate={{ opacity: 0, y: -50, x: fe.x }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.7, ease: "easeOut" }}
								style={{ bottom: "100%", left: "50%" }}
							>
								{fe.emoji}
							</motion.span>
						))}
					</AnimatePresence>

					<div className="w-px h-4 bg-gray-5 mx-1 md:mx-2 hidden sm:block" />
					<motion.button
						type="button"
						className="px-2.5 md:px-3 py-1 md:py-1.5 bg-gray-12 text-white text-[9px] md:text-[10px] font-medium rounded-full cursor-pointer flex items-center gap-1"
						whileTap={{ scale: 0.92 }}
						onClick={() => setShowCommentInput((prev) => !prev)}
					>
						<MessageCircle className="size-2.5" />
						评论
					</motion.button>
				</div>
			</motion.div>

			<AnimatePresence>
				{showCommentInput && (
					<motion.div
						className="px-4 md:px-6 mt-2"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.2 }}
					>
						<div className="flex items-center gap-2 p-2 bg-white rounded-xl border border-gray-5">
							<div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 shrink-0" />
							<div className="flex-1 text-[10px] text-gray-8 select-none">
								添加评论……
							</div>
							<div className="px-2 py-0.5 bg-gray-12 text-white text-[8px] font-medium rounded-full">
								发送
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<motion.div
				className="px-4 md:px-6 mt-3 md:mt-4 pb-4 md:pb-6"
				initial={{ opacity: 0, y: 10 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true }}
				transition={{ duration: 0.4, delay: 0.5 }}
			>
				<div className="p-3 md:p-4 bg-white rounded-xl md:rounded-2xl border border-gray-3">
					<h4 className="text-xs md:text-sm font-medium text-gray-12">摘要</h4>
					<span className="text-[9px] md:text-[10px] font-medium text-gray-8">
						由 Cap AI 生成
					</span>
					<p className="text-[10px] md:text-xs text-gray-11 mt-1.5 md:mt-2 leading-relaxed">
						从零构建可复用 React
						组件的分步指南，涵盖属性、状态管理和生产应用的测试最佳实践。
					</p>

					<h4 className="text-xs md:text-sm font-medium text-gray-12 mt-3 md:mt-4 mb-1.5 md:mb-2">
						章节
					</h4>
					<div className="divide-y divide-gray-3">
						{[
							{ time: "0:00", title: "简介" },
							{ time: "0:45", title: "项目设置" },
							{ time: "1:30", title: "构建组件" },
						].map((chapter, i) => (
							<motion.button
								key={chapter.time}
								type="button"
								className={`flex items-center w-full py-1.5 md:py-2 px-1.5 md:px-2 rounded cursor-pointer transition-colors ${
									activeChapter === i ? "bg-blue-50" : "hover:bg-gray-2"
								}`}
								onClick={() => setActiveChapter(activeChapter === i ? null : i)}
								whileTap={{ scale: 0.98 }}
							>
								<span
									className={`w-10 md:w-14 text-[9px] md:text-xs shrink-0 text-left ${
										activeChapter === i
											? "text-blue-500 font-medium"
											: "text-gray-9"
									}`}
								>
									{chapter.time}
								</span>
								<span
									className={`text-[10px] md:text-xs ${
										activeChapter === i
											? "text-blue-600 font-medium"
											: "text-gray-12"
									}`}
								>
									{chapter.title}
								</span>
							</motion.button>
						))}
					</div>
				</div>
			</motion.div>

			<AnimatePresence>
				{linkCopied && (
					<motion.div
						className="absolute bottom-3 md:bottom-5 left-1/2 -translate-x-1/2 z-20"
						initial={{ opacity: 0, y: 15, scale: 0.9 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: -5, scale: 0.95 }}
						transition={{
							type: "spring",
							stiffness: 400,
							damping: 25,
						}}
					>
						<div className="bg-gray-12 text-white text-[10px] md:text-xs font-medium px-3 md:px-4 py-1.5 md:py-2 rounded-full flex items-center gap-1.5 md:gap-2 shadow-lg whitespace-nowrap">
							<Check className="size-3 md:size-3.5 text-green-400" />
							链接已复制到剪贴板
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
};

const InstantModeDetail = () => {
	return (
		<div className="w-full max-w-[1000px] mx-auto px-5">
			<motion.div
				initial={{ opacity: 0, y: 30 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-80px" }}
				transition={{ duration: 0.6 }}
				className="text-center mb-8 md:mb-12"
			>
				<motion.div
					className="flex items-center justify-center gap-2 mb-4"
					initial={{ opacity: 0, scale: 0.8 }}
					whileInView={{ opacity: 1, scale: 1 }}
					viewport={{ once: true }}
					transition={{
						duration: 0.5,
						type: "spring",
						stiffness: 200,
					}}
				>
					<motion.div
						animate={{ rotate: [0, -10, 10, -5, 0] }}
						transition={{
							duration: 2,
							repeat: Number.POSITIVE_INFINITY,
							repeatDelay: 3,
							ease: "easeInOut",
						}}
					>
						<Zap fill="yellow" className="size-5" strokeWidth={1.5} />
					</motion.div>
					<span className="text-sm font-medium text-amber-600 uppercase tracking-wider">
						即时模式
					</span>
				</motion.div>
				<motion.h2
					className="text-3xl md:text-4xl font-medium text-gray-12 mb-3"
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true }}
					transition={{ duration: 0.5, delay: 0.1 }}
				>
					即时分享屏幕或摄像头
				</motion.h2>
				<motion.p
					className="text-base md:text-lg text-gray-10 max-w-[600px] mx-auto"
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true }}
					transition={{ duration: 0.5, delay: 0.2 }}
				>
					点击录制、停止并分享。视频会自动生成 AI
					标题、摘要、章节和文字稿，并立即上线。
				</motion.p>
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 40, scale: 0.97 }}
				whileInView={{ opacity: 1, y: 0, scale: 1 }}
				viewport={{ once: true, margin: "-60px" }}
				transition={{
					duration: 0.7,
					delay: 0.15,
					ease: [0.25, 0.1, 0.25, 1],
				}}
				className="relative"
			>
				<div className="absolute -inset-4 md:-inset-8 bg-gradient-to-b from-amber-100/40 via-amber-50/20 to-transparent rounded-3xl blur-2xl pointer-events-none" />
				<div className="relative rounded-2xl border border-gray-5 bg-gray-2 shadow-xl shadow-black/5 overflow-hidden">
					<MockSharePage />
				</div>
			</motion.div>

			<motion.div
				variants={featureContainerVariants}
				initial="hidden"
				whileInView="visible"
				viewport={{ once: true, margin: "-40px" }}
				className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3 mt-5 md:mt-6"
			>
				{instantFeatures.map((feature) => (
					<motion.div
						key={feature.title}
						variants={featureItemVariants}
						whileHover={{
							y: -3,
							transition: {
								type: "spring",
								stiffness: 400,
								damping: 25,
							},
						}}
						className="flex items-start gap-2.5 sm:gap-3 p-3 sm:p-4 rounded-xl border border-gray-5 bg-gray-1 transition-shadow hover:shadow-md hover:border-amber-200"
					>
						<div className="text-amber-600 mt-0.5 shrink-0">{feature.icon}</div>
						<div>
							<h4 className="text-sm font-medium text-gray-12">
								{feature.title}
							</h4>
							<p className="text-xs text-gray-10 mt-0.5">
								{feature.description}
							</p>
						</div>
					</motion.div>
				))}
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-40px" }}
				transition={{ duration: 0.5, delay: 0.3 }}
				className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mt-5 md:mt-6"
			>
				<Button href="/features/instant-mode" variant="white" size="lg">
					了解更多
				</Button>
				<UpgradeToPro />
			</motion.div>
		</div>
	);
};

export default InstantModeDetail;
