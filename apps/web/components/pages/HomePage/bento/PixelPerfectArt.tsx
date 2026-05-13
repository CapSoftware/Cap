"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Cpu, Gauge, Maximize } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const badges = [
	{ icon: Maximize, label: "4K UHD" },
	{ icon: Gauge, label: "60 FPS" },
	{ icon: Cpu, label: "HW-Accelerated" },
];

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60)
		.toString()
		.padStart(2, "0");
	const s = (seconds % 60).toString().padStart(2, "0");
	return `${m}:${s}`;
}

export default function PixelPerfectArt({ className }: { className?: string }) {
	const reduced = useReducedMotion();
	const [elapsed, setElapsed] = useState(23);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		if (reduced) return;
		intervalRef.current = setInterval(() => {
			setElapsed((prev) => (prev + 1) % 60);
		}, 1000);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [reduced]);

	const dividerVariants = reduced
		? {}
		: {
				animate: {
					left: ["25%", "75%", "25%"],
					transition: {
						duration: 6,
						ease: "easeInOut",
						repeat: Number.POSITIVE_INFINITY,
						repeatType: "loop" as const,
					},
				},
			};

	return (
		<div
			className={`relative flex flex-col gap-3 w-full h-full select-none ${className ?? ""}`}
		>
			<div className="relative flex-1 rounded-xl overflow-hidden border border-[var(--gray-5,#e2e8f0)] bg-[var(--gray-1,#fafafa)] flex flex-col min-h-0">
				<div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--gray-5,#e2e8f0)] bg-[var(--gray-2,#f4f4f5)] shrink-0">
					<span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
					<span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
					<span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
					<div className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20">
						<motion.span
							className="w-2 h-2 rounded-full bg-red-500 shrink-0"
							animate={reduced ? {} : { opacity: [1, 0.3, 1] }}
							transition={
								reduced
									? {}
									: { duration: 1.2, repeat: Number.POSITIVE_INFINITY }
							}
						/>
						<span className="text-[10px] font-mono font-semibold text-red-500 leading-none">
							REC 4K • {formatTime(elapsed)}
						</span>
					</div>
				</div>

				<div className="relative flex-1 overflow-hidden min-h-0">
					<div className="absolute inset-0">
						<div
							className="absolute inset-0"
							style={{
								background:
									"linear-gradient(135deg, #a5b4fc 0%, #818cf8 40%, #6366f1 70%, #4f46e5 100%)",
							}}
						/>
						<div
							className="absolute inset-0 rounded-lg mx-6 my-4"
							style={{
								background: "rgba(255,255,255,0.12)",
								backdropFilter: "blur(2px)",
								boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
							}}
						/>
						<div
							className="absolute inset-x-10 top-8 bottom-8 rounded-md"
							style={{
								background: "rgba(255,255,255,0.08)",
								boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
							}}
						/>
						<div
							className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full flex items-center justify-center"
							style={{
								background: "rgba(255,255,255,0.22)",
								boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
							}}
						>
							<div
								className="w-0 h-0"
								style={{
									borderTop: "7px solid transparent",
									borderBottom: "7px solid transparent",
									borderLeft: "12px solid rgba(255,255,255,0.9)",
									marginLeft: "2px",
								}}
							/>
						</div>
					</div>

					<div
						className="absolute inset-0 overflow-hidden"
						style={{
							clipPath: `inset(0 ${reduced ? "50%" : "var(--clip-right, 50%)"} 0 0)`,
						}}
					>
						<motion.div
							className="absolute inset-0"
							initial={
								reduced ? undefined : ({ "--clip-right": "50%" } as never)
							}
							animate={
								reduced
									? undefined
									: ({
											"--clip-right": ["75%", "25%", "75%"],
										} as never)
							}
							transition={
								reduced
									? undefined
									: {
											duration: 6,
											ease: "easeInOut",
											repeat: Number.POSITIVE_INFINITY,
											repeatType: "loop",
										}
							}
						>
							<div
								className="absolute inset-0"
								style={{
									background:
										"linear-gradient(135deg, #a5b4fc 0%, #818cf8 40%, #6366f1 70%, #4f46e5 100%)",
									imageRendering: "pixelated",
									filter: "blur(0px)",
								}}
							/>
							<div
								className="absolute inset-0"
								style={{
									backgroundImage: `
										linear-gradient(to right, rgba(80,70,180,0.55) 1px, transparent 1px),
										linear-gradient(to bottom, rgba(80,70,180,0.55) 1px, transparent 1px)
									`,
									backgroundSize: "12px 12px",
									mixBlendMode: "multiply",
								}}
							/>
							<div
								className="absolute inset-0 rounded-lg mx-6 my-4"
								style={{
									background: "rgba(255,255,255,0.10)",
									filter: "blur(1.5px)",
								}}
							/>
						</motion.div>
					</div>

					<motion.div
						className="absolute top-0 bottom-0 w-px bg-white/80 shadow-[0_0_6px_2px_rgba(255,255,255,0.4)] z-10"
						style={{ left: reduced ? "50%" : "25%" }}
						{...dividerVariants}
					>
						<div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-white border border-white/60 shadow-md flex items-center justify-center">
							<div className="flex gap-px">
								<span className="w-px h-3 bg-gray-400 rounded-full" />
								<span className="w-px h-3 bg-gray-400 rounded-full" />
							</div>
						</div>
					</motion.div>

					<div className="absolute bottom-2 left-2 z-10">
						<span className="text-[9px] font-semibold text-white/60 uppercase tracking-wider bg-black/20 px-1.5 py-0.5 rounded">
							Pixelated
						</span>
					</div>
					<div className="absolute bottom-2 right-2 z-10">
						<span className="text-[9px] font-semibold text-white/60 uppercase tracking-wider bg-black/20 px-1.5 py-0.5 rounded">
							4K Sharp
						</span>
					</div>
				</div>
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{badges.map(({ icon: Icon, label }, i) => (
					<motion.div
						key={label}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--gray-5,#e2e8f0)] bg-[var(--gray-1,#fafafa)] text-[var(--gray-12,#111)]"
						initial={reduced ? undefined : { opacity: 0, scale: 0.85 }}
						animate={reduced ? undefined : { opacity: 1, scale: 1 }}
						transition={
							reduced
								? undefined
								: { delay: 0.3 + i * 0.15, duration: 0.35, ease: "easeOut" }
						}
					>
						<Icon className="w-3.5 h-3.5 text-blue-500 shrink-0" />
						<span className="text-[11px] font-semibold whitespace-nowrap">
							{label}
						</span>
					</motion.div>
				))}
			</div>
		</div>
	);
}
