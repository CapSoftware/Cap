"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { InstantIcon, ScreenshotIcon, StudioIcon } from "./modeIcons";

type ModeId = "instant" | "studio" | "screenshot";

interface ModeOption {
	id: ModeId;
	title: string;
	description: string;
	icon: (props: { className?: string }) => React.JSX.Element;
}

const modes: ModeOption[] = [
	{
		id: "instant",
		title: "Instant",
		description:
			"Share instantly with a link. Your recording uploads as you record, so you can share it immediately when you're done.",
		icon: InstantIcon,
	},
	{
		id: "studio",
		title: "Studio",
		description:
			"Record locally in the highest quality for editing later. Perfect for creating polished content with effects and transitions.",
		icon: StudioIcon,
	},
	{
		id: "screenshot",
		title: "Screenshot",
		description:
			"Capture and annotate screenshots instantly. Great for quick captures, bug reports, and visual communication.",
		icon: ScreenshotIcon,
	},
];

const AUTO_CYCLE_INTERVAL = 3500;

const PILL_GAP = { base: 16, md: 20 };
const PILL_PADDING = { base: 12, md: 14 };
const CIRCLE_SIZE = { base: 72, md: 88 };

const RecordingModePicker = () => {
	const [selected, setSelected] = useState<ModeId>("instant");
	const [userInteracted, setUserInteracted] = useState(false);
	const [isInView, setIsInView] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	const handleSelect = useCallback((id: ModeId) => {
		setUserInteracted(true);
		setSelected(id);
	}, []);

	useEffect(() => {
		if (userInteracted || !isInView) return;

		const interval = setInterval(() => {
			setSelected((prev) => {
				const currentIndex = modes.findIndex((m) => m.id === prev);
				const nextMode = modes[(currentIndex + 1) % modes.length];
				return nextMode ? nextMode.id : prev;
			});
		}, AUTO_CYCLE_INTERVAL);

		return () => clearInterval(interval);
	}, [userInteracted, isInView]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry) {
					setIsInView(entry.isIntersecting);
				}
			},
			{ threshold: 0.3 },
		);

		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const selectedMode = modes.find((m) => m.id === selected);

	return (
		<div ref={containerRef} className="w-full max-w-[1000px] mx-auto px-5">
			<motion.div
				initial={{ opacity: 0, y: 30 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-80px" }}
				transition={{ duration: 0.6 }}
				className="text-center mb-8 md:mb-14"
			>
				<span className="inline-block text-xs font-semibold text-gray-9 uppercase tracking-[0.2em] mb-3">
					3 Modes
				</span>
				<h2 className="text-3xl md:text-4xl font-medium text-gray-12 mb-3">
					One app, every workflow
				</h2>
				<p className="text-base md:text-lg text-gray-10 max-w-[600px] mx-auto">
					Whether you need speed, studio quality, or a quick screenshot — Cap
					has a mode for it.
				</p>
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				viewport={{ once: true, margin: "-40px" }}
				transition={{ duration: 0.5, delay: 0.15 }}
				className="flex flex-col items-center"
			>
				<div className="relative">
					<div
						className="md:hidden absolute rounded-full border border-gray-5 bg-gray-3 left-0 right-0 top-0"
						style={{
							height: `${CIRCLE_SIZE.base + PILL_PADDING.base * 2}px`,
						}}
					/>
					<div
						className="hidden md:block absolute rounded-full border border-gray-5 bg-gray-3 left-0 right-0 top-0"
						style={{
							height: `${CIRCLE_SIZE.md + PILL_PADDING.md * 2}px`,
						}}
					/>

					<div
						className="relative grid grid-cols-3 md:hidden"
						style={{
							gap: `${PILL_GAP.base}px`,
							padding: `${PILL_PADDING.base}px`,
						}}
					>
						{modes.map((mode) => {
							const isSelected = selected === mode.id;

							return (
								<div
									key={mode.id}
									className="flex flex-col items-center"
									style={{ width: `${CIRCLE_SIZE.base}px` }}
								>
									<motion.button
										type="button"
										onClick={() => handleSelect(mode.id)}
										className="relative flex items-center justify-center rounded-full cursor-pointer"
										style={{
											width: `${CIRCLE_SIZE.base}px`,
											height: `${CIRCLE_SIZE.base}px`,
										}}
										animate={{
											backgroundColor: isSelected
												? "var(--gray-7)"
												: "var(--gray-3)",
										}}
										whileHover={{
											backgroundColor: "var(--gray-7)",
										}}
										transition={{ duration: 0.2 }}
									>
										{isSelected && (
											<motion.div
												className="absolute inset-0 rounded-full"
												layoutId="modeRing"
												style={{
													boxShadow:
														"0 0 0 3px var(--gray-1), 0 0 0 5px var(--blue-9)",
												}}
												transition={{
													type: "spring",
													stiffness: 400,
													damping: 30,
												}}
											/>
										)}
										<mode.icon
											className={`size-7 transition-colors duration-200 ${
												isSelected ? "text-gray-12" : "text-gray-10"
											}`}
										/>
									</motion.button>

									<motion.span
										className="mt-3 text-sm font-medium whitespace-nowrap cursor-pointer"
										onClick={() => handleSelect(mode.id)}
										animate={{
											color: isSelected ? "var(--gray-12)" : "var(--gray-9)",
											opacity: isSelected ? 1 : 0.6,
										}}
										transition={{ duration: 0.2 }}
									>
										{mode.title}
									</motion.span>
								</div>
							);
						})}
					</div>

					<div
						className="relative hidden md:grid grid-cols-3"
						style={{
							gap: `${PILL_GAP.md}px`,
							padding: `${PILL_PADDING.md}px`,
						}}
					>
						{modes.map((mode) => {
							const isSelected = selected === mode.id;

							return (
								<div
									key={mode.id}
									className="flex flex-col items-center"
									style={{ width: `${CIRCLE_SIZE.md}px` }}
								>
									<motion.button
										type="button"
										onClick={() => handleSelect(mode.id)}
										className="relative flex items-center justify-center rounded-full cursor-pointer"
										style={{
											width: `${CIRCLE_SIZE.md}px`,
											height: `${CIRCLE_SIZE.md}px`,
										}}
										animate={{
											backgroundColor: isSelected
												? "var(--gray-7)"
												: "var(--gray-3)",
										}}
										whileHover={{
											backgroundColor: "var(--gray-7)",
										}}
										transition={{ duration: 0.2 }}
									>
										{isSelected && (
											<motion.div
												className="absolute inset-0 rounded-full"
												layoutId="modeRingMd"
												style={{
													boxShadow:
														"0 0 0 3px var(--gray-1), 0 0 0 5.5px var(--blue-9)",
												}}
												transition={{
													type: "spring",
													stiffness: 400,
													damping: 30,
												}}
											/>
										)}
										<mode.icon
											className={`size-8 transition-colors duration-200 ${
												isSelected ? "text-gray-12" : "text-gray-10"
											}`}
										/>
									</motion.button>

									<motion.span
										className="mt-4 text-[15px] font-medium whitespace-nowrap cursor-pointer"
										onClick={() => handleSelect(mode.id)}
										animate={{
											color: isSelected ? "var(--gray-12)" : "var(--gray-9)",
											opacity: isSelected ? 1 : 0.6,
										}}
										transition={{ duration: 0.2 }}
									>
										{mode.title}
									</motion.span>
								</div>
							);
						})}
					</div>
				</div>

				<AnimatePresence mode="wait">
					{selectedMode && (
						<motion.div
							key={selectedMode.id}
							initial={{ opacity: 0, y: 8 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -8 }}
							transition={{ duration: 0.25, ease: "easeOut" }}
							className="mt-6 md:mt-8 max-w-[480px] text-center px-2"
						>
							<p className="text-base text-gray-10 leading-relaxed">
								{selectedMode.description}
							</p>
						</motion.div>
					)}
				</AnimatePresence>
			</motion.div>
		</div>
	);
};

export default RecordingModePicker;
