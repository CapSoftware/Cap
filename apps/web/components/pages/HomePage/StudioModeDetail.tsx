"use client";

import { Button } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import {
	Camera,
	Check,
	Clapperboard,
	Image as ImageIcon,
	Layers,
	Maximize2,
	MessageSquare,
	MousePointer2,
	MousePointerClick,
	Palette,
	Pause,
	Play,
	Square,
	Volume2,
	Wind,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import UpgradeToPro from "../_components/UpgradeToPro";

const GRADIENTS = [
	"linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
	"linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
	"linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
	"linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
	"linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
	"linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
];

const GRADIENT_COLORS: [string, string][] = [
	["#667eea", "#764ba2"],
	["#f093fb", "#f5576c"],
	["#4facfe", "#00f2fe"],
	["#43e97b", "#38f9d7"],
	["#fa709a", "#fee140"],
	["#a18cd1", "#fbc2eb"],
];

interface AutoConfig {
	gradientIndex: number;
	padding: number;
	rounded: number;
	shadow: number;
	cursorSize: number;
}

const AUTO_CONFIGS: AutoConfig[] = [
	{ gradientIndex: 0, padding: 0, rounded: 0, shadow: 0, cursorSize: 200 },
	{ gradientIndex: 0, padding: 14, rounded: 0, shadow: 0, cursorSize: 200 },
	{ gradientIndex: 0, padding: 14, rounded: 18, shadow: 0, cursorSize: 200 },
	{ gradientIndex: 0, padding: 14, rounded: 18, shadow: 80, cursorSize: 200 },
	{ gradientIndex: 0, padding: 14, rounded: 18, shadow: 80, cursorSize: 80 },
	{ gradientIndex: 3, padding: 10, rounded: 24, shadow: 50, cursorSize: 150 },
];

const AUTO_STEP_DELAYS = [800, 1200, 2000, 2500, 2500, 3000];

const PREVIEW_CURSOR_DURATION = 8;

const studioFeatures = [
	{
		icon: <Palette className="size-5" />,
		title: "Custom Backgrounds",
		description: "Gradients, wallpapers & colors",
	},
	{
		icon: <Maximize2 className="size-5" />,
		title: "Adjustable Padding",
		description: "Scale from 0% to 40%",
	},
	{
		icon: <Square className="size-5" />,
		title: "Rounded Corners",
		description: "Squircle or rounded styles",
	},
	{
		icon: <Wind className="size-5" />,
		title: "Motion Blur",
		description: "Natural movement effects",
	},
	{
		icon: <Layers className="size-5" />,
		title: "Shadow & Borders",
		description: "Customizable depth effects",
	},
	{
		icon: <MousePointerClick className="size-5" />,
		title: "Cursor Effects",
		description: "Sizing, smoothing & click effects",
	},
];

const EASE = [0.4, 0, 0.2, 1] as const;

const InteractiveSlider = ({
	label,
	value,
	min,
	max,
	unit,
	onChange,
	onInteract,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	unit: string;
	onChange: (v: number) => void;
	onInteract: () => void;
}) => {
	const trackRef = useRef<HTMLDivElement>(null);
	const isDraggingRef = useRef(false);
	const [dragging, setDragging] = useState(false);

	const updateFromPointer = useCallback(
		(clientX: number) => {
			if (!trackRef.current) return;
			const rect = trackRef.current.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
			onChange(Math.round(min + pct * (max - min)));
		},
		[min, max, onChange],
	);

	const pct = max - min > 0 ? ((value - min) / (max - min)) * 100 : 0;

	return (
		<div>
			<div className="flex items-center justify-between mb-1.5">
				<span className="text-[9px] font-medium text-gray-11">{label}</span>
				<span className="text-[8px] font-mono text-gray-9">
					{value}
					{unit}
				</span>
			</div>
			<div
				ref={trackRef}
				className="relative h-5 flex items-center cursor-pointer touch-none"
				onPointerDown={(e) => {
					e.preventDefault();
					onInteract();
					isDraggingRef.current = true;
					setDragging(true);
					trackRef.current?.setPointerCapture(e.pointerId);
					updateFromPointer(e.clientX);
				}}
				onPointerMove={(e) => {
					if (!isDraggingRef.current) return;
					updateFromPointer(e.clientX);
				}}
				onPointerUp={() => {
					isDraggingRef.current = false;
					setDragging(false);
				}}
			>
				<div className="h-1 rounded-full bg-gray-4 w-full relative">
					<div
						className="absolute left-0 top-0 h-full rounded-full bg-blue-500"
						style={{
							width: `${pct}%`,
							transition: dragging ? "none" : "width 0.6s ease",
						}}
					/>
					<div
						className="absolute top-1/2 w-3 h-3 rounded-full bg-white border-2 border-blue-500 shadow-sm shadow-blue-200/50"
						style={{
							left: `${pct}%`,
							transform: "translate(-50%, -50%)",
							transition: dragging ? "none" : "left 0.6s ease",
						}}
					/>
				</div>
			</div>
		</div>
	);
};

const MockScreenContent = () => (
	<div className="w-full h-full bg-white overflow-hidden">
		<div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200/70 bg-gray-50/80">
			<div className="flex gap-1">
				<div className="w-1.5 h-1.5 rounded-full bg-[#FF5F57]" />
				<div className="w-1.5 h-1.5 rounded-full bg-[#FFBD2E]" />
				<div className="w-1.5 h-1.5 rounded-full bg-[#28C840]" />
			</div>
			<div className="h-2 rounded bg-gray-200/60 flex-1 max-w-[60px] mx-auto" />
		</div>
		<div className="flex h-[calc(100%-22px)]">
			<div className="w-5 border-r border-gray-200/70 bg-gray-50/50 flex flex-col gap-1.5 p-1 pt-2">
				<div className="w-full aspect-square rounded bg-blue-100/80" />
				<div className="w-full aspect-square rounded bg-gray-200/60" />
				<div className="w-full aspect-square rounded bg-gray-200/60" />
			</div>
			<div className="flex-1 p-2">
				<div className="h-2 rounded bg-gray-200/70 w-3/4 mb-2" />
				<div className="h-1.5 rounded bg-gray-200/50 w-full mb-1" />
				<div className="h-1.5 rounded bg-gray-200/50 w-5/6 mb-3" />
				<div className="grid grid-cols-2 gap-1.5 mb-2">
					<div className="rounded-lg bg-blue-50 border border-blue-100/80 p-2">
						<div className="h-1.5 rounded bg-blue-200/50 w-3/4 mb-1.5" />
						<div className="h-1 rounded bg-blue-100/70 w-full" />
					</div>
					<div className="rounded-lg bg-gray-50 border border-gray-200/60 p-2">
						<div className="h-1.5 rounded bg-gray-200/50 w-2/3 mb-1.5" />
						<div className="h-1 rounded bg-gray-100 w-full" />
					</div>
				</div>
				<div className="flex gap-1.5">
					<div className="h-4 px-3 rounded bg-blue-500 flex items-center">
						<div className="h-1 w-6 rounded bg-white/40" />
					</div>
					<div className="h-4 px-3 rounded bg-gray-100 border border-gray-200/80 flex items-center">
						<div className="h-1 w-8 rounded bg-gray-300/70" />
					</div>
				</div>
			</div>
		</div>
	</div>
);

const CursorSvg = ({ size = 18 }: { size?: number }) => {
	const height = Math.round((size / 18) * 25);
	return (
		<svg
			width={size}
			height={height}
			viewBox="0 0 17 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Cursor"
			style={{
				filter:
					"drop-shadow(0 2px 6px rgba(0,0,0,0.25)) drop-shadow(0 1px 2px rgba(0,0,0,0.15))",
			}}
		>
			<title>Cursor</title>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M4.501 3.2601L12.884 11.6611C13.937 12.7171 13.19 14.5191 11.699 14.5191L10.475 14.519L11.6908 17.4067C11.9038 17.9127 11.9068 18.4727 11.6998 18.9817C11.4918 19.4917 11.0978 19.8897 10.5898 20.1027C10.3338 20.2097 10.0658 20.2637 9.7918 20.2637C8.9608 20.2637 8.2158 19.7687 7.8938 19.0027L6.616 15.965L5.784 16.7031C4.703 17.6591 3 16.8921 3 15.4481V3.8811C3 3.0971 3.947 2.7051 4.501 3.2601Z"
				fill="white"
			/>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M4 4.53033C4 4.39933 4.159 4.33333 4.251 4.42633L12.159 12.3513C12.59 12.7833 12.284 13.5203 11.674 13.5203L8.97 13.5188L10.7696 17.7947C10.9966 18.3347 10.7426 18.9557 10.2036 19.1817C9.6626 19.4087 9.0426 19.1557 8.8166 18.6167L6.999 14.2928L5.139 15.9403C4.723 16.3083 4.0811 16.0518 4.007 15.5285L4 15.4273V4.53033Z"
				fill="black"
			/>
		</svg>
	);
};

const MockEditor = () => {
	const [userInteracted, setUserInteracted] = useState(false);
	const [autoStep, setAutoStep] = useState(0);

	const [gradientIndex, setGradientIndex] = useState(0);
	const [padding, setPadding] = useState(0);
	const [rounded, setRounded] = useState(0);
	const [shadow, setShadow] = useState(0);
	const [cursorSize, setCursorSize] = useState(200);

	const [isPlaying, setIsPlaying] = useState(true);

	const [exportState, setExportState] = useState<"idle" | "exporting" | "done">(
		"idle",
	);
	const [shareCopied, setShareCopied] = useState(false);
	const [shaking, setShaking] = useState(false);

	useEffect(() => {
		if (userInteracted) return;
		let timeout: ReturnType<typeof setTimeout>;
		let cancelled = false;

		const advance = (current: number) => {
			if (cancelled) return;
			const next = (current + 1) % AUTO_CONFIGS.length;
			const cfg = AUTO_CONFIGS[next];
			if (!cfg) return;
			setGradientIndex(cfg.gradientIndex);
			setPadding(cfg.padding);
			setRounded(cfg.rounded);
			setShadow(cfg.shadow);
			setCursorSize(cfg.cursorSize);
			setAutoStep(next);
			timeout = setTimeout(() => advance(next), AUTO_STEP_DELAYS[next] || 2500);
		};

		timeout = setTimeout(() => advance(0), AUTO_STEP_DELAYS[0]);

		return () => {
			cancelled = true;
			clearTimeout(timeout);
		};
	}, [userInteracted]);

	const handleInteraction = useCallback(() => {
		setUserInteracted(true);
	}, []);

	const handleExport = useCallback(() => {
		handleInteraction();
		if (exportState !== "idle") return;
		setExportState("exporting");
		setTimeout(() => {
			setExportState("done");
			setTimeout(() => setExportState("idle"), 1500);
		}, 2000);
	}, [exportState, handleInteraction]);

	const handleShare = useCallback(() => {
		handleInteraction();
		setShareCopied(true);
		setTimeout(() => setShareCopied(false), 2000);
	}, [handleInteraction]);

	const handleRedDot = useCallback(() => {
		setShaking(true);
		setTimeout(() => setShaking(false), 500);
	}, []);

	const handleGradientClick = useCallback(
		(i: number) => {
			handleInteraction();
			setGradientIndex(gradientIndex === i ? -1 : i);
		},
		[handleInteraction, gradientIndex],
	);

	const handlePlayPause = useCallback(() => {
		handleInteraction();
		setIsPlaying((prev) => !prev);
	}, [handleInteraction]);

	const shadowFraction = shadow / 100;

	return (
		<motion.div
			className="absolute inset-0 flex flex-col select-none overflow-hidden"
			animate={shaking ? { x: [0, -3, 3, -3, 3, -2, 2, 0] } : { x: 0 }}
			transition={{ duration: 0.4 }}
		>
			<style>{`
				@keyframes previewCursorMove {
					0% { left: 20%; top: 25%; }
					15% { left: 55%; top: 42%; }
					30% { left: 72%; top: 22%; }
					50% { left: 40%; top: 58%; }
					65% { left: 28%; top: 68%; }
					85% { left: 62%; top: 35%; }
					100% { left: 20%; top: 25%; }
				}
				@keyframes previewProgress {
					0% { width: 0%; }
					100% { width: 100%; }
				}
			`}</style>
			<div className="flex items-center justify-between px-3 md:px-4 py-2 md:py-2.5 border-b border-gray-4 bg-gray-2 shrink-0">
				<div className="flex items-center gap-2">
					<div className="flex gap-1.5">
						<motion.div
							className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#FF5F57] cursor-pointer"
							whileHover={{ scale: 1.4 }}
							whileTap={{ scale: 0.7 }}
							onClick={handleRedDot}
						/>
						<motion.div
							className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#FFBD2E] cursor-pointer"
							whileHover={{ scale: 1.4 }}
							whileTap={{ scale: 0.7 }}
						/>
						<motion.div
							className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#28C840] cursor-pointer"
							whileHover={{ scale: 1.4 }}
							whileTap={{ scale: 0.7 }}
						/>
					</div>
					<span className="text-[9px] md:text-[10px] text-gray-10 ml-1 md:ml-2">
						My Recording.cap
					</span>
				</div>
				<div className="flex items-center gap-1.5 md:gap-2">
					<motion.button
						type="button"
						className="px-2 md:px-2.5 py-0.5 md:py-1 rounded-md border border-gray-5 text-[8px] md:text-[9px] text-gray-11 font-medium cursor-pointer flex items-center gap-1 min-w-[40px] justify-center"
						whileTap={{ scale: 0.93 }}
						onClick={handleShare}
					>
						{shareCopied ? (
							<>
								<Check className="size-2 md:size-2.5 text-green-500" />
								<span className="text-green-600">Copied!</span>
							</>
						) : (
							"Share"
						)}
					</motion.button>
					<motion.button
						type="button"
						className="px-2 md:px-2.5 py-0.5 md:py-1 rounded-md bg-blue-500 text-white text-[8px] md:text-[9px] font-medium cursor-pointer flex items-center gap-1 min-w-[40px] justify-center overflow-hidden"
						whileTap={{ scale: 0.93 }}
						onClick={handleExport}
					>
						<AnimatePresence mode="wait" initial={false}>
							{exportState === "idle" && (
								<motion.span
									key="idle"
									initial={{ opacity: 0, y: 8 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -8 }}
									transition={{ duration: 0.15 }}
								>
									Export
								</motion.span>
							)}
							{exportState === "exporting" && (
								<motion.div
									key="exporting"
									className="w-8 md:w-10 h-1.5 rounded-full bg-white/20 overflow-hidden"
									initial={{ opacity: 0, y: 8 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -8 }}
									transition={{ duration: 0.15 }}
								>
									<motion.div
										className="h-full rounded-full bg-white"
										initial={{ width: "0%" }}
										animate={{ width: "100%" }}
										transition={{ duration: 1.8, ease: "easeInOut" }}
									/>
								</motion.div>
							)}
							{exportState === "done" && (
								<motion.span
									key="done"
									className="flex items-center gap-0.5"
									initial={{ opacity: 0, y: 8 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -8 }}
									transition={{ duration: 0.15 }}
								>
									<Check className="size-2.5 text-green-300" />
									Done!
								</motion.span>
							)}
						</AnimatePresence>
					</motion.button>
				</div>
			</div>

			<div className="flex-1 flex min-h-0">
				<div className="flex-1 flex items-center justify-center p-3 md:p-6 bg-gray-3 overflow-hidden relative">
					<div className="relative w-full aspect-video overflow-hidden rounded-md">
						<motion.div
							className="absolute inset-0 bg-[#e8e8e8]"
							initial={false}
							animate={{ opacity: gradientIndex === -1 ? 1 : 0 }}
							transition={{ duration: 0.6 }}
						/>
						{GRADIENTS.map((grad, i) => (
							<motion.div
								key={grad}
								className="absolute inset-0"
								style={{ background: grad }}
								initial={false}
								animate={{ opacity: gradientIndex === i ? 1 : 0 }}
								transition={{ duration: 0.6 }}
							/>
						))}

						<motion.div
							className="absolute z-10"
							initial={false}
							animate={{
								top: `${padding}%`,
								left: `${padding}%`,
								right: `${padding}%`,
								bottom: `${padding}%`,
							}}
							transition={{ duration: 0.8, ease: EASE }}
						>
							<motion.div
								className="w-full h-full overflow-hidden"
								initial={false}
								animate={{
									borderRadius: `${rounded}px`,
									boxShadow:
										shadowFraction > 0
											? `0 25px 50px -12px rgba(0,0,0,${0.35 * shadowFraction}), 0 12px 24px -8px rgba(0,0,0,${0.2 * shadowFraction})`
											: "0 0 0 0px rgba(0,0,0,0)",
								}}
								transition={{ duration: 0.8, ease: EASE }}
							>
								<MockScreenContent />
							</motion.div>
						</motion.div>

						<div
							className="absolute pointer-events-none z-20"
							style={{
								left: "20%",
								top: "25%",
								animation: `previewCursorMove ${PREVIEW_CURSOR_DURATION}s ease-in-out infinite`,
								animationPlayState: isPlaying ? "running" : "paused",
							}}
						>
							<motion.div
								style={{ transformOrigin: "0 0" }}
								initial={false}
								animate={{ scale: cursorSize / 100 }}
								transition={{
									type: "spring",
									stiffness: 200,
									damping: 20,
								}}
							>
								<CursorSvg size={14} />
							</motion.div>
						</div>

						<div className="absolute bottom-0 left-0 right-0 z-30 flex items-center gap-1.5 px-2 py-1.5 bg-gradient-to-t from-black/40 to-transparent">
							<motion.button
								type="button"
								className="shrink-0 cursor-pointer"
								onClick={handlePlayPause}
								whileTap={{ scale: 0.8 }}
							>
								{isPlaying ? (
									<Pause className="size-3 text-white" fill="white" />
								) : (
									<Play className="size-3 text-white ml-px" fill="white" />
								)}
							</motion.button>
							<div className="flex-1 h-0.5 rounded-full bg-white/30 relative overflow-hidden">
								<div
									className="absolute left-0 top-0 h-full rounded-full bg-white/80"
									style={{
										width: "0%",
										animation: `previewProgress ${PREVIEW_CURSOR_DURATION}s linear infinite`,
										animationPlayState: isPlaying ? "running" : "paused",
									}}
								/>
							</div>
							<span className="text-[8px] text-white/70 font-mono shrink-0">
								0:12
							</span>
						</div>
					</div>

					<div className="md:hidden absolute bottom-2 left-2 z-20">
						<AnimatePresence mode="wait">
							{!userInteracted && AUTO_CONFIGS[autoStep] && (
								<motion.div
									key={autoStep}
									className="bg-black/75 backdrop-blur-sm rounded-lg px-2.5 py-1 text-white text-[9px] font-medium flex items-center gap-1.5"
									initial={{ opacity: 0, y: 4 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0, y: -4 }}
									transition={{ duration: 0.2 }}
								>
									<div className="w-1 h-1 rounded-full bg-blue-400" />
									{autoStep === 0 || autoStep === 5
										? "Background"
										: autoStep === 1
											? "Padding"
											: autoStep === 2
												? "Corners"
												: autoStep === 3
													? "Shadow"
													: "Cursor Size"}
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				</div>

				<div className="hidden md:flex w-40 lg:w-48 xl:w-52 border-l border-gray-4 bg-gray-1 flex-col shrink-0 overflow-hidden">
					<div className="flex items-center justify-around px-2 py-2 border-b border-gray-4 shrink-0">
						<div className="p-1 lg:p-1.5 rounded-md bg-blue-50 text-blue-600">
							<ImageIcon className="size-3" />
						</div>
						<div className="p-1 lg:p-1.5 rounded-md text-gray-8">
							<Camera className="size-3" />
						</div>
						<div className="p-1 lg:p-1.5 rounded-md text-gray-8">
							<Volume2 className="size-3" />
						</div>
						<div className="p-1 lg:p-1.5 rounded-md text-gray-8">
							<MousePointer2 className="size-3" />
						</div>
						<div className="p-1 lg:p-1.5 rounded-md text-gray-8">
							<MessageSquare className="size-3" />
						</div>
					</div>

					<div className="flex-1 p-2.5 lg:p-3 space-y-3 lg:space-y-3.5 overflow-y-auto">
						<div>
							<span className="text-[9px] font-medium block mb-2 text-gray-11">
								Background
							</span>
							<div className="flex gap-1.5 flex-wrap">
								{GRADIENT_COLORS.map(([from, to], i) => (
									<motion.button
										key={from}
										type="button"
										className="relative cursor-pointer"
										onClick={() => handleGradientClick(i)}
										whileTap={{ scale: 0.85 }}
									>
										<motion.div
											className="w-4 h-4 lg:w-5 lg:h-5 rounded-full shrink-0"
											style={{
												background: `linear-gradient(135deg, ${from}, ${to})`,
											}}
											initial={false}
											animate={{
												scale: gradientIndex === i ? 1.15 : 1,
												boxShadow:
													gradientIndex === i
														? "0 0 0 1.5px white, 0 0 0 2.5px rgba(59,130,246,0.5)"
														: "0 0 0 0.5px rgba(0,0,0,0.1)",
											}}
											transition={{ duration: 0.3 }}
										/>
									</motion.button>
								))}
							</div>
						</div>

						<InteractiveSlider
							label="Padding"
							value={padding}
							min={0}
							max={40}
							unit="%"
							onChange={setPadding}
							onInteract={handleInteraction}
						/>

						<InteractiveSlider
							label="Rounded Corners"
							value={rounded}
							min={0}
							max={40}
							unit="px"
							onChange={setRounded}
							onInteract={handleInteraction}
						/>

						<InteractiveSlider
							label="Shadow"
							value={shadow}
							min={0}
							max={100}
							unit="%"
							onChange={setShadow}
							onInteract={handleInteraction}
						/>

						<div className="pt-2 border-t border-gray-4">
							<InteractiveSlider
								label="Cursor Size"
								value={cursorSize}
								min={30}
								max={300}
								unit="%"
								onChange={setCursorSize}
								onInteract={handleInteraction}
							/>
						</div>
					</div>
				</div>
			</div>
		</motion.div>
	);
};

const StudioModeDetail = () => {
	return (
		<div className="w-full max-w-[1000px] mx-auto px-5">
			<motion.div
				initial={{ opacity: 0, y: 30 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-80px" }}
				transition={{ duration: 0.6 }}
				className="text-center mb-8 md:mb-12"
			>
				<div className="flex items-center justify-center gap-2 mb-4">
					<Clapperboard
						fill="var(--blue-9)"
						className="size-5"
						strokeWidth={1.5}
					/>
					<span className="text-sm font-medium text-blue-11 uppercase tracking-wider">
						Studio Mode
					</span>
				</div>
				<h2 className="text-3xl md:text-4xl font-medium text-gray-12 mb-3">
					Record in full quality, edit before you share
				</h2>
				<p className="text-base md:text-lg text-gray-10 max-w-[600px] mx-auto">
					Studio mode records at the highest quality directly to your device —
					no compression, no upload. Then customize backgrounds, padding,
					corners, and more before sharing.
				</p>
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
				<div className="absolute -inset-4 md:-inset-8 bg-gradient-to-b from-blue-100/40 via-blue-50/20 to-transparent rounded-3xl blur-2xl pointer-events-none" />
				<div
					className="relative rounded-xl md:rounded-2xl border border-gray-5 bg-white shadow-xl shadow-black/5 overflow-hidden"
					style={{ aspectRatio: "16/10", minHeight: "220px" }}
				>
					<MockEditor />
				</div>
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-40px" }}
				transition={{ duration: 0.5, delay: 0.2 }}
				className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3 mt-5 md:mt-8"
			>
				{studioFeatures.map((feature) => (
					<div
						key={feature.title}
						className="flex items-start gap-2.5 sm:gap-3 p-3 sm:p-4 rounded-xl border border-gray-5 bg-gray-1"
					>
						<div className="text-blue-11 mt-0.5 shrink-0">{feature.icon}</div>
						<div>
							<h4 className="text-sm font-medium text-gray-12">
								{feature.title}
							</h4>
							<p className="text-xs text-gray-10 mt-0.5">
								{feature.description}
							</p>
						</div>
					</div>
				))}
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-40px" }}
				transition={{ duration: 0.5, delay: 0.3 }}
				className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mt-6 md:mt-10"
			>
				<Button href="/features/studio-mode" variant="white" size="lg">
					Learn more
				</Button>
				<UpgradeToPro />
			</motion.div>
		</div>
	);
};

export default StudioModeDetail;
