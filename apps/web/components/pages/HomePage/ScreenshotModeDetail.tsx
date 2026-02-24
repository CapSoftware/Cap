"use client";

import { Button } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import {
	Aperture,
	Check,
	Circle,
	Copy,
	Image as ImageIcon,
	Layers,
	Maximize2,
	MousePointer2,
	MoveUpRight,
	Palette,
	Save,
	Scan,
	Square,
	Type,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
	showAnnotation: boolean;
}

const AUTO_CONFIGS: AutoConfig[] = [
	{
		gradientIndex: -1,
		padding: 0,
		rounded: 0,
		shadow: 0,
		showAnnotation: false,
	},
	{
		gradientIndex: 0,
		padding: 0,
		rounded: 0,
		shadow: 0,
		showAnnotation: false,
	},
	{
		gradientIndex: 0,
		padding: 14,
		rounded: 0,
		shadow: 0,
		showAnnotation: false,
	},
	{
		gradientIndex: 0,
		padding: 14,
		rounded: 18,
		shadow: 0,
		showAnnotation: false,
	},
	{
		gradientIndex: 0,
		padding: 14,
		rounded: 18,
		shadow: 80,
		showAnnotation: false,
	},
	{
		gradientIndex: 4,
		padding: 12,
		rounded: 22,
		shadow: 60,
		showAnnotation: true,
	},
];

const AUTO_STEP_DELAYS = [1000, 1500, 1500, 1500, 1500, 3000];

const screenshotFeatures = [
	{
		icon: <Palette className="size-5" />,
		title: "Beautiful Backgrounds",
		description: "Gradients, wallpapers & solid colors",
	},
	{
		icon: <Maximize2 className="size-5" />,
		title: "Adjustable Padding",
		description: "Clean spacing around your capture",
	},
	{
		icon: <Square className="size-5" />,
		title: "Rounded Corners",
		description: "Squircle or rounded styles",
	},
	{
		icon: <Layers className="size-5" />,
		title: "Shadow & Borders",
		description: "Professional depth effects",
	},
	{
		icon: <MoveUpRight className="size-5" />,
		title: "Annotation Tools",
		description: "Arrows, shapes, text & masks",
	},
	{
		icon: <Copy className="size-5" />,
		title: "Instant Copy & Save",
		description: "One click to clipboard or file",
	},
];

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
						className="absolute left-0 top-0 h-full rounded-full bg-violet-500"
						style={{
							width: `${pct}%`,
							transition: dragging ? "none" : "width 0.6s ease",
						}}
					/>
					<div
						className="absolute top-1/2 w-3 h-3 rounded-full bg-white border-2 border-violet-500 shadow-sm shadow-violet-200/50"
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

const MockCodeEditorContent = () => (
	<div className="w-full h-full bg-[#1e1e2e] overflow-hidden">
		<div className="flex items-center gap-1 px-2 py-1.5 bg-[#181825]">
			<div className="flex gap-1">
				<div className="w-1.5 h-1.5 rounded-full bg-[#FF5F57]" />
				<div className="w-1.5 h-1.5 rounded-full bg-[#FFBD2E]" />
				<div className="w-1.5 h-1.5 rounded-full bg-[#28C840]" />
			</div>
			<div className="flex items-center gap-1 mx-auto">
				<div className="h-2 rounded bg-[#313244] w-[50px]" />
			</div>
		</div>
		<div className="flex h-[calc(100%-22px)]">
			<div className="w-6 bg-[#181825] flex flex-col items-end pr-1.5 pt-1.5 gap-[3px]">
				{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
					<div
						key={`ln-${n}`}
						className="text-[5px] text-[#585b70] leading-[7px] font-mono"
					>
						{n}
					</div>
				))}
			</div>
			<div className="flex-1 p-1.5 pt-1.5 space-y-[3px]">
				<div className="flex gap-1">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-8" />
					<div className="h-[7px] rounded-sm bg-[#cdd6f4] w-5" />
					<div className="h-[7px] rounded-sm bg-[#a6e3a1] w-9" />
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-4" />
					<div className="h-[7px] rounded-sm bg-[#a6e3a1] w-7" />
				</div>
				<div className="flex gap-1">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-6" />
					<div className="h-[7px] rounded-sm bg-[#89b4fa] w-12" />
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-4" />
					<div className="h-[7px] rounded-sm bg-[#a6e3a1] w-6" />
				</div>
				<div className="h-[7px]" />
				<div className="flex gap-1">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-7" />
					<div className="h-[7px] rounded-sm bg-[#f9e2af] w-14" />
					<div className="h-[7px] rounded-sm bg-[#89dceb] w-5" />
				</div>
				<div className="flex gap-1 pl-3">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-5" />
					<div className="h-[7px] rounded-sm bg-[#a6e3a1] w-12" />
				</div>
				<div className="flex gap-1 pl-3">
					<div className="h-[7px] rounded-sm bg-[#89b4fa] w-8" />
					<div className="h-[7px] rounded-sm bg-[#f38ba8] w-5" />
					<div className="h-[7px] rounded-sm bg-[#89dceb] w-10" />
				</div>
				<div className="flex gap-1 pl-3">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-4" />
					<div className="h-[7px] rounded-sm bg-[#f9e2af] w-16" />
				</div>
				<div className="flex gap-1 pl-3">
					<div className="h-[7px] rounded-sm bg-[#a6e3a1] w-10" />
					<div className="h-[7px] rounded-sm bg-[#89b4fa] w-6" />
				</div>
				<div className="flex gap-1 pl-3">
					<div className="h-[7px] rounded-sm bg-[#89dceb] w-6" />
					<div className="h-[7px] rounded-sm bg-[#f38ba8] w-12" />
					<div className="h-[7px] rounded-sm bg-[#cdd6f4] w-4" />
				</div>
				<div className="flex gap-1">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-3" />
				</div>
				<div className="h-[7px]" />
				<div className="flex gap-1">
					<div className="h-[7px] rounded-sm bg-[#cba6f7] w-9" />
					<div className="h-[7px] rounded-sm bg-[#f38ba8] w-6" />
				</div>
			</div>
		</div>
	</div>
);

const AnnotationArrow = () => {
	const markerId = useId();
	return (
		<motion.svg
			className="absolute inset-0 w-full h-full pointer-events-none z-20"
			initial={{ opacity: 0, pathLength: 0 }}
			animate={{ opacity: 1, pathLength: 1 }}
			transition={{ duration: 0.5, ease: "easeOut" }}
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<defs>
				<marker
					id={markerId}
					markerWidth="8"
					markerHeight="6"
					refX="8"
					refY="3"
					orient="auto"
				>
					<path d="M0,0 L8,3 L0,6 Z" fill="#ef4444" />
				</marker>
			</defs>
			<motion.line
				x1="78"
				y1="18"
				x2="52"
				y2="45"
				stroke="#ef4444"
				strokeWidth="0.8"
				strokeLinecap="round"
				markerEnd={`url(#${markerId})`}
				initial={{ pathLength: 0 }}
				animate={{ pathLength: 1 }}
				transition={{ duration: 0.6, delay: 0.1 }}
			/>
		</motion.svg>
	);
};

type HotkeyPhase = "idle" | "appearing" | "pressing" | "captured" | "done";

const MockScreenshotEditor = () => {
	const [editorReady, setEditorReady] = useState(false);
	const [hotkeyPhase, setHotkeyPhase] = useState<HotkeyPhase>("idle");
	const [userInteracted, setUserInteracted] = useState(false);
	const [autoStep, setAutoStep] = useState(0);
	const [isInView, setIsInView] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	const [gradientIndex, setGradientIndex] = useState(-1);
	const [padding, setPadding] = useState(0);
	const [rounded, setRounded] = useState(0);
	const [shadow, setShadow] = useState(0);
	const [showAnnotation, setShowAnnotation] = useState(false);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry?.isIntersecting && !isInView) {
					setIsInView(true);
				}
			},
			{ threshold: 0.2 },
		);

		observer.observe(el);
		return () => observer.disconnect();
	}, [isInView]);

	useEffect(() => {
		if (!isInView) return;

		const timers: ReturnType<typeof setTimeout>[] = [];
		timers.push(setTimeout(() => setHotkeyPhase("appearing"), 200));
		timers.push(setTimeout(() => setHotkeyPhase("pressing"), 1100));
		timers.push(setTimeout(() => setHotkeyPhase("captured"), 1600));
		timers.push(
			setTimeout(() => {
				setHotkeyPhase("done");
				setEditorReady(true);
			}, 2300),
		);

		return () => {
			for (const t of timers) clearTimeout(t);
		};
	}, [isInView]);

	useEffect(() => {
		if (!editorReady || userInteracted) return;
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
			setShowAnnotation(cfg.showAnnotation);
			setAutoStep(next);
			timeout = setTimeout(() => advance(next), AUTO_STEP_DELAYS[next] || 2000);
		};

		timeout = setTimeout(() => advance(0), AUTO_STEP_DELAYS[0]);

		return () => {
			cancelled = true;
			clearTimeout(timeout);
		};
	}, [editorReady, userInteracted]);

	const handleInteraction = useCallback(() => {
		setUserInteracted(true);
	}, []);

	const handleCopy = useCallback(() => {
		handleInteraction();
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [handleInteraction]);

	const handleGradientClick = useCallback(
		(i: number) => {
			handleInteraction();
			setGradientIndex(gradientIndex === i ? -1 : i);
		},
		[handleInteraction, gradientIndex],
	);

	const shadowFraction = shadow / 100;

	const hotkeyKeys = [
		{ label: "⌘", width: "min-w-[36px] md:min-w-[44px]" },
		{ label: "⇧", width: "min-w-[36px] md:min-w-[44px]" },
		{ label: "S", width: "min-w-[36px] md:min-w-[44px]" },
	];

	const isPressed = hotkeyPhase === "pressing" || hotkeyPhase === "captured";

	return (
		<div ref={containerRef} className="absolute inset-0">
			<motion.div
				className="absolute inset-0 flex flex-col select-none overflow-hidden"
				initial={{ opacity: 0 }}
				animate={{ opacity: editorReady ? 1 : 0 }}
				transition={{ duration: 0.5, delay: 0.1 }}
			>
				<div className="flex items-center justify-between px-3 md:px-4 py-2 md:py-2.5 border-b border-gray-4 bg-gray-2 shrink-0">
					<div className="flex items-center gap-2">
						<div className="flex gap-1.5">
							<div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#FF5F57]" />
							<div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#FFBD2E]" />
							<div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#28C840]" />
						</div>
						<span className="text-[9px] md:text-[10px] text-gray-10 ml-1 md:ml-2">
							Screenshot.png
						</span>
					</div>

					<div className="flex items-center gap-1 md:gap-1.5">
						<div className="hidden md:flex items-center gap-0.5 mr-2 border-r border-gray-4 pr-2">
							<div className="p-1 rounded text-gray-8 hover:bg-gray-3">
								<MousePointer2 className="size-2.5" />
							</div>
							<div className="p-1 rounded text-gray-8 hover:bg-gray-3">
								<MoveUpRight className="size-2.5" />
							</div>
							<div className="p-1 rounded text-gray-8 hover:bg-gray-3">
								<Square className="size-2.5" />
							</div>
							<div className="p-1 rounded text-gray-8 hover:bg-gray-3">
								<Circle className="size-2.5" />
							</div>
							<div className="p-1 rounded text-gray-8 hover:bg-gray-3">
								<Type className="size-2.5" />
							</div>
						</div>

						<motion.button
							type="button"
							className="px-2 md:px-2.5 py-0.5 md:py-1 rounded-md border border-gray-5 text-[8px] md:text-[9px] text-gray-11 font-medium cursor-pointer flex items-center gap-1 min-w-[36px] justify-center"
							whileTap={{ scale: 0.93 }}
							onClick={handleCopy}
						>
							{copied ? (
								<>
									<Check className="size-2 md:size-2.5 text-green-500" />
									<span className="text-green-600">Copied!</span>
								</>
							) : (
								<>
									<Copy className="size-2 md:size-2.5" />
									Copy
								</>
							)}
						</motion.button>
						<motion.button
							type="button"
							className="px-2 md:px-2.5 py-0.5 md:py-1 rounded-md bg-violet-500 text-white text-[8px] md:text-[9px] font-medium cursor-pointer flex items-center gap-1 min-w-[36px] justify-center"
							whileTap={{ scale: 0.93 }}
							onClick={handleInteraction}
						>
							<Save className="size-2 md:size-2.5" />
							Save
						</motion.button>
					</div>
				</div>

				<div className="flex-1 flex min-h-0">
					<div className="flex-1 flex items-center justify-center p-3 md:p-6 bg-gray-3 overflow-hidden relative">
						<div className="relative w-full aspect-[4/3] max-h-full overflow-hidden rounded-md">
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
									className="w-full h-full overflow-hidden relative"
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
									<MockCodeEditorContent />
								</motion.div>

								<AnimatePresence>
									{showAnnotation && <AnnotationArrow />}
								</AnimatePresence>
							</motion.div>
						</div>

						<div className="md:hidden absolute bottom-2 left-2 z-20">
							<AnimatePresence mode="wait">
								{!userInteracted && AUTO_CONFIGS[autoStep] && editorReady && (
									<motion.div
										key={autoStep}
										className="bg-black/75 backdrop-blur-sm rounded-lg px-2.5 py-1 text-white text-[9px] font-medium flex items-center gap-1.5"
										initial={{ opacity: 0, y: 4 }}
										animate={{ opacity: 1, y: 0 }}
										exit={{ opacity: 0, y: -4 }}
										transition={{ duration: 0.2 }}
									>
										<div className="w-1 h-1 rounded-full bg-violet-400" />
										{autoStep === 0 || autoStep === 1
											? "Background"
											: autoStep === 2
												? "Padding"
												: autoStep === 3
													? "Corners"
													: autoStep === 4
														? "Shadow"
														: "Annotation"}
									</motion.div>
								)}
							</AnimatePresence>
						</div>
					</div>

					<div className="hidden md:flex w-40 lg:w-48 xl:w-52 border-l border-gray-4 bg-gray-1 flex-col shrink-0 overflow-hidden">
						<div className="flex items-center justify-around px-2 py-2 border-b border-gray-4 shrink-0">
							<div className="p-1 lg:p-1.5 rounded-md bg-violet-50 text-violet-600">
								<ImageIcon className="size-3" />
							</div>
							<div className="p-1 lg:p-1.5 rounded-md text-gray-8">
								<Layers className="size-3" />
							</div>
							<div className="p-1 lg:p-1.5 rounded-md text-gray-8">
								<Scan className="size-3" />
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
															? "0 0 0 1.5px white, 0 0 0 2.5px rgba(139,92,246,0.5)"
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
						</div>
					</div>
				</div>
			</motion.div>

			<AnimatePresence>
				{!editorReady && (
					<motion.div
						className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white"
						exit={{ opacity: 0 }}
						transition={{ duration: 0.4 }}
					>
						{hotkeyPhase === "captured" && (
							<motion.div
								className="absolute inset-0 bg-white pointer-events-none z-10"
								initial={{ opacity: 0 }}
								animate={{ opacity: [0, 0.7, 0] }}
								transition={{ duration: 0.4, times: [0, 0.3, 1] }}
							/>
						)}

						<div className="flex items-center gap-2 md:gap-3">
							{hotkeyKeys.map((key, i) => (
								<div key={key.label} className="contents">
									{i > 0 && (
										<motion.span
											className="text-gray-7 text-base md:text-lg font-light select-none"
											initial={{ opacity: 0 }}
											animate={{
												opacity: hotkeyPhase !== "idle" ? 0.6 : 0,
											}}
											transition={{ delay: i * 0.12 + 0.05 }}
										>
											+
										</motion.span>
									)}
									<motion.div
										className={`
											inline-flex items-center justify-center ${key.width}
											h-[36px] md:h-[44px] px-3 md:px-4
											rounded-[10px] text-sm md:text-base font-semibold
											border-2 select-none
											${
												isPressed
													? "bg-gray-4 border-gray-5 text-gray-12"
													: "bg-white border-gray-4 text-gray-11"
											}
										`}
										style={{
											boxShadow: isPressed
												? "inset 0 2px 4px rgba(0,0,0,0.08)"
												: "0 2px 4px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
										}}
										initial={{ opacity: 0, y: 12, scale: 0.85 }}
										animate={{
											opacity: hotkeyPhase !== "idle" ? 1 : 0,
											y: isPressed ? 2 : 0,
											scale: isPressed ? 0.95 : 1,
										}}
										transition={{
											delay: hotkeyPhase === "appearing" ? i * 0.12 : 0,
											type: "spring",
											stiffness: 400,
											damping: 25,
										}}
									>
										{key.label}
									</motion.div>
								</div>
							))}
						</div>

						<AnimatePresence>
							{hotkeyPhase === "captured" && (
								<motion.div
									className="mt-5 flex items-center gap-2"
									initial={{ opacity: 0, y: 8 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.25 }}
								>
									<div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
										<Check className="size-3 text-green-600" />
									</div>
									<span className="text-sm text-gray-10 font-medium">
										Screenshot captured
									</span>
								</motion.div>
							)}
						</AnimatePresence>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
};

const ScreenshotModeDetail = () => {
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
						animate={{
							scale: [1, 0.88, 1],
							opacity: [1, 0.7, 1],
						}}
						transition={{
							duration: 0.4,
							repeat: Number.POSITIVE_INFINITY,
							repeatDelay: 4,
							ease: "easeInOut",
						}}
					>
						<Aperture className="size-5 text-violet-500" strokeWidth={2} />
					</motion.div>
					<span className="text-sm font-medium text-violet-600 uppercase tracking-wider">
						Screenshot Mode
					</span>
				</motion.div>
				<motion.h2
					className="text-3xl md:text-4xl font-medium text-gray-12 mb-3"
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true }}
					transition={{ duration: 0.5, delay: 0.1 }}
				>
					Capture, beautify, share
				</motion.h2>
				<motion.p
					className="text-base md:text-lg text-gray-10 max-w-[600px] mx-auto"
					initial={{ opacity: 0, y: 20 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true }}
					transition={{ duration: 0.5, delay: 0.2 }}
				>
					Take a screenshot with a hotkey, then instantly enhance it with
					backgrounds, padding, annotations, and more — ready to share in
					seconds.
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
				<div className="absolute -inset-4 md:-inset-8 bg-gradient-to-b from-violet-100/40 via-violet-50/20 to-transparent rounded-3xl blur-2xl pointer-events-none" />
				<div
					className="relative rounded-xl md:rounded-2xl border border-gray-5 bg-white shadow-xl shadow-black/5 overflow-hidden"
					style={{ aspectRatio: "16/10", minHeight: "220px" }}
				>
					<MockScreenshotEditor />
				</div>
			</motion.div>

			<motion.div
				variants={featureContainerVariants}
				initial="hidden"
				whileInView="visible"
				viewport={{ once: true, margin: "-40px" }}
				className="grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3 mt-5 md:mt-6"
			>
				{screenshotFeatures.map((feature) => (
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
						className="flex items-start gap-2.5 sm:gap-3 p-3 sm:p-4 rounded-xl border border-gray-5 bg-gray-1 transition-shadow hover:shadow-md hover:border-violet-200"
					>
						<div className="text-violet-600 mt-0.5 shrink-0">
							{feature.icon}
						</div>
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
				<Button href="/features/screenshot-mode" variant="white" size="lg">
					Learn more
				</Button>
				<UpgradeToPro />
			</motion.div>
		</div>
	);
};

export default ScreenshotModeDetail;
