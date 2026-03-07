"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

const InstantIcon = ({ className }: { className?: string }) => (
	<svg
		viewBox="0 0 152 223"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
		aria-hidden="true"
	>
		<path
			d="M150.167 109.163L53.4283 220.65C52.4032 221.826 51.05 222.613 49.573 222.89C48.0959 223.167 46.5752 222.919 45.2403 222.185C43.9054 221.451 42.8287 220.27 42.1727 218.82C41.5167 217.369 41.317 215.729 41.6038 214.146L54.2661 146.019L4.48901 125.914C3.41998 125.484 2.46665 124.776 1.7142 123.853C0.961745 122.93 0.433602 121.82 0.176954 120.624C-0.0796948 119.428 -0.0568536 118.182 0.243435 116.997C0.543723 115.813 1.1121 114.727 1.8978 113.837L98.6363 2.35043C99.6614 1.17365 101.015 0.387451 102.492 0.110461C103.969 -0.166529 105.489 0.080724 106.824 0.814909C108.159 1.54909 109.236 2.73037 109.892 4.18049C110.548 5.63061 110.748 7.27088 110.461 8.85379L97.7639 77.0554L147.541 97.1322C148.602 97.5652 149.548 98.2727 150.294 99.1922C151.041 100.112 151.566 101.215 151.822 102.404C152.078 103.593 152.058 104.832 151.763 106.011C151.468 107.19 150.908 108.273 150.132 109.163H150.167Z"
			fill="currentColor"
		/>
	</svg>
);

const StudioIcon = ({ className }: { className?: string }) => (
	<svg
		viewBox="0 0 124 119"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
		aria-hidden="true"
	>
		<path
			d="M119.04 49.5796H48.42L115.32 31.9207C115.954 31.7539 116.548 31.4634 117.068 31.0659C117.588 30.6684 118.025 30.1718 118.352 29.6047C118.68 29.0377 118.891 28.4115 118.975 27.7621C119.06 27.1128 119.014 26.4533 118.842 25.8217L113.783 7.22689C113.087 4.72519 111.433 2.59843 109.179 1.30722C106.926 0.0160012 104.254 -0.335719 101.743 0.328232L7.32875 25.2452C6.07164 25.5715 4.89225 26.1452 3.85965 26.9328C2.82705 27.7203 1.96198 28.706 1.31509 29.8319C0.664581 30.9441 0.244302 32.1756 0.0792245 33.4533C-0.0858532 34.7311 0.00763733 36.0289 0.354142 37.2698L4.96668 54.2654C4.96668 54.3522 4.96668 54.4452 4.96668 54.5382V109.083C4.96668 111.713 6.01176 114.235 7.87202 116.095C9.73228 117.955 12.2553 119 14.8861 119H114.081C116.711 119 119.234 117.955 121.095 116.095C122.955 114.235 124 111.713 124 109.083V54.5382C124 53.2231 123.477 51.9618 122.547 51.0319C121.617 50.102 120.356 49.5796 119.04 49.5796ZM104.26 9.91073L107.98 23.5903L87.1555 29.1253L69.7159 19.0346L104.26 9.91073ZM33.2061 28.6728L50.6395 38.7388L13.6896 48.4887L9.9698 34.8029L33.2061 28.6728Z"
			fill="currentColor"
		/>
	</svg>
);

const ScreenshotIcon = ({ className }: { className?: string }) => (
	<svg
		viewBox="0 0 24 24"
		fill="currentColor"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
		aria-hidden="true"
	>
		<path d="M21,2H3A1,1,0,0,0,2,3V21a1,1,0,0,0,1,1H21a1,1,0,0,0,1-1V3A1,1,0,0,0,21,2ZM20,14l-3-3-5,5-2-2L4,20V4H20ZM6,8.5A2.5,2.5,0,1,1,8.5,11,2.5,2.5,0,0,1,6,8.5Z" />
	</svg>
);

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
				const next = modes[(currentIndex + 1) % modes.length];
				return next ? next.id : prev;
			});
		}, AUTO_CYCLE_INTERVAL);

		return () => clearInterval(interval);
	}, [userInteracted, isInView]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (entry) setIsInView(entry.isIntersecting);
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
