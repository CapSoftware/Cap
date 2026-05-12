"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Activity, Globe, Zap } from "lucide-react";
import { useEffect, useState } from "react";

interface PerfValues {
	capCpu: number;
	capRam: number;
	elCpu: number;
	elRam: number;
}

const STATIC: PerfValues = {
	capCpu: 8,
	capRam: 128,
	elCpu: 72,
	elRam: 680,
};

const RAM_MAX = 1024;

function randomBetween(min: number, max: number) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function PerformanceBar({
	value,
	max,
	accent,
}: {
	value: number;
	max: number;
	accent: "blue" | "muted";
}) {
	const pct = Math.min((value / max) * 100, 100);
	return (
		<div className="relative h-1.5 w-full rounded-full bg-gray-3 overflow-hidden">
			<motion.div
				className={
					accent === "blue"
						? "absolute inset-y-0 left-0 rounded-full bg-blue-500"
						: "absolute inset-y-0 left-0 rounded-full bg-gray-9"
				}
				animate={{ width: `${pct}%` }}
				transition={{ duration: 0.6, ease: "easeOut" }}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

function StatRow({
	cpu,
	ram,
	accent,
}: {
	cpu: number;
	ram: number;
	accent: "blue" | "muted";
}) {
	return (
		<div className="flex flex-col gap-2 w-full">
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<span className="text-[10px] font-medium text-gray-10">CPU</span>
					<motion.span
						key={cpu}
						className={
							accent === "blue"
								? "text-[10px] font-semibold tabular-nums text-blue-500"
								: "text-[10px] font-semibold tabular-nums text-gray-10"
						}
						initial={{ opacity: 0.6 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.3 }}
					>
						{cpu}%
					</motion.span>
				</div>
				<PerformanceBar value={cpu} max={100} accent={accent} />
			</div>
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<span className="text-[10px] font-medium text-gray-10">RAM</span>
					<motion.span
						key={ram}
						className={
							accent === "blue"
								? "text-[10px] font-semibold tabular-nums text-blue-500"
								: "text-[10px] font-semibold tabular-nums text-gray-10"
						}
						initial={{ opacity: 0.6 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.3 }}
					>
						{ram} MB
					</motion.span>
				</div>
				<PerformanceBar value={ram} max={RAM_MAX} accent={accent} />
			</div>
		</div>
	);
}

export default function NativePerformanceArt({
	className,
}: {
	className?: string;
}) {
	const reduced = useReducedMotion();
	const [values, setValues] = useState<PerfValues>(STATIC);

	useEffect(() => {
		if (reduced) return;

		const id = setInterval(() => {
			setValues({
				capCpu: randomBetween(4, 14),
				capRam: randomBetween(110, 140),
				elCpu: randomBetween(55, 85),
				elRam: randomBetween(580, 720),
			});
		}, 800);

		return () => clearInterval(id);
	}, [reduced]);

	return (
		<div
			className={`flex flex-col gap-4 w-full h-full p-4 select-none ${className ?? ""}`}
		>
			<div className="flex items-center gap-1.5">
				<Activity className="w-3 h-3 text-green-500" />
				<span className="text-[11px] font-medium text-gray-10 uppercase tracking-wide">
					Live performance
				</span>
				{!reduced && (
					<motion.div
						className="w-1.5 h-1.5 rounded-full bg-green-500 ml-0.5"
						animate={{ opacity: [1, 0.3, 1] }}
						transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
					/>
				)}
				{reduced && (
					<div className="w-1.5 h-1.5 rounded-full bg-green-500 ml-0.5" />
				)}
			</div>

			<div className="flex flex-col gap-3 flex-1">
				<div
					className="flex gap-3 p-3 rounded-xl border border-gray-5 bg-gray-1"
					style={{
						boxShadow:
							"0 0 0 1px rgba(59,130,246,0.15), 0 0 12px rgba(59,130,246,0.08)",
					}}
				>
					<div className="flex items-center gap-2 min-w-[110px]">
						<div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-500 shrink-0">
							<Zap className="w-3.5 h-3.5 text-white" />
						</div>
						<div className="flex flex-col">
							<span className="text-[11px] font-semibold text-gray-12 leading-tight">
								Cap
							</span>
							<span className="text-[10px] text-blue-500 leading-tight">
								Native
							</span>
						</div>
					</div>
					<StatRow cpu={values.capCpu} ram={values.capRam} accent="blue" />
				</div>

				<div className="flex gap-3 p-3 rounded-xl border border-gray-5 bg-gray-2">
					<div className="flex items-center gap-2 min-w-[110px]">
						<div className="flex items-center justify-center w-6 h-6 rounded-md bg-gray-3 border border-gray-5 shrink-0">
							<Globe className="w-3.5 h-3.5 text-gray-10" />
						</div>
						<div className="flex flex-col">
							<span className="text-[11px] font-semibold text-gray-12 leading-tight">
								Electron App
							</span>
							<span className="text-[10px] text-gray-9 leading-tight">
								Chromium
							</span>
						</div>
					</div>
					<StatRow cpu={values.elCpu} ram={values.elRam} accent="muted" />
				</div>
			</div>
		</div>
	);
}
