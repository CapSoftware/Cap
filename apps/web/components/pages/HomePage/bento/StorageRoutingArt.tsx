"use client";

import clsx from "clsx";
import { motion, useReducedMotion } from "framer-motion";
import { Cloud, Database, HardDrive } from "lucide-react";
import { useId } from "react";

interface ArtProps {
	className?: string;
}

interface Destination {
	id: string;
	label: string;
	icon: React.ReactNode;
	cy: number;
	primary?: boolean;
}

interface Packet {
	id: number;
	delay: number;
}

const DESTINATIONS: Destination[] = [
	{
		id: "cloud",
		label: "Cap Cloud",
		icon: <Cloud size={14} />,
		cy: 60,
	},
	{
		id: "s3",
		label: "Your S3",
		icon: <Database size={14} />,
		cy: 140,
		primary: true,
	},
	{
		id: "disk",
		label: "Local Disk",
		icon: <HardDrive size={14} />,
		cy: 220,
	},
];

const PACKETS: Packet[] = [
	{ id: 0, delay: 0 },
	{ id: 1, delay: 1.1 },
	{ id: 2, delay: 2.2 },
];

const SOURCE_X = 90;
const SOURCE_CY = 140;
const BRANCH_X = 220;
const DEST_X = 380;
const SVG_W = 480;
const SVG_H = 280;

function buildPath(destCy: number): string {
	const mx = (SOURCE_X + BRANCH_X) / 2;
	const bx = (BRANCH_X + DEST_X) / 2;
	return `M ${SOURCE_X} ${SOURCE_CY} C ${mx} ${SOURCE_CY}, ${mx} ${SOURCE_CY}, ${BRANCH_X} ${SOURCE_CY} C ${bx} ${SOURCE_CY}, ${bx} ${destCy}, ${DEST_X} ${destCy}`;
}

function AnimatedPacket({
	destCy,
	delay,
	primary,
	reduced,
}: {
	destCy: number;
	delay: number;
	primary: boolean;
	reduced: boolean;
}) {
	const path = buildPath(destCy);

	if (reduced) {
		return (
			<circle
				cx={DEST_X}
				cy={destCy}
				r={4}
				className={primary ? "fill-blue-500" : "fill-gray-400"}
				opacity={0.7}
			/>
		);
	}

	return (
		<motion.circle
			r={4}
			className={primary ? "fill-blue-500" : "fill-gray-400"}
			initial={{ offsetDistance: "0%", opacity: 0 }}
			animate={{
				offsetDistance: ["0%", "100%"],
				opacity: [0, 1, 1, 0],
			}}
			transition={{
				duration: 3,
				delay,
				repeat: Number.POSITIVE_INFINITY,
				ease: "easeInOut",
				times: [0, 0.1, 0.85, 1],
			}}
			style={{
				offsetPath: `path("${path}")`,
				offsetRotate: "0deg",
			}}
		/>
	);
}

function PathLine({
	destCy,
	primary,
	delay,
}: {
	destCy: number;
	primary: boolean;
	delay: number;
}) {
	const d = buildPath(destCy);
	return (
		<motion.path
			d={d}
			fill="none"
			strokeWidth={1.5}
			strokeLinecap="round"
			className={primary ? "stroke-blue-500/40" : "stroke-gray-300/40"}
			initial={{ pathLength: 0, opacity: 0 }}
			animate={{ pathLength: 1, opacity: 1 }}
			transition={{ duration: 0.6, delay, ease: "easeOut" }}
		/>
	);
}

const StorageRoutingArt = ({ className }: ArtProps) => {
	const reduced = useReducedMotion() ?? false;
	const uid = useId();
	const gridId = `grid-dots-${uid}`;

	return (
		<div
			className={clsx(
				"relative flex items-center justify-center w-full overflow-hidden rounded-xl bg-gray-1 border border-gray-5",
				className,
			)}
			style={{ minHeight: 260 }}
		>
			<svg
				viewBox={`0 0 ${SVG_W} ${SVG_H}`}
				className="w-full h-full"
				style={{ maxHeight: 300 }}
				aria-hidden="true"
			>
				<defs>
					<pattern
						id={gridId}
						width="20"
						height="20"
						patternUnits="userSpaceOnUse"
					>
						<circle cx="1" cy="1" r="0.8" className="fill-gray-400/20" />
					</pattern>
				</defs>

				<rect
					x={0}
					y={0}
					width={SVG_W}
					height={SVG_H}
					fill={`url(#${gridId})`}
				/>

				{DESTINATIONS.map((dest, i) => (
					<PathLine
						key={dest.id}
						destCy={dest.cy}
						primary={dest.primary ?? false}
						delay={reduced ? 0 : 0.3 + i * 0.1}
					/>
				))}

				{DESTINATIONS.map((dest) =>
					PACKETS.map((pkt) => (
						<AnimatedPacket
							key={`${dest.id}-${pkt.id}`}
							destCy={dest.cy}
							delay={
								pkt.delay + (dest.primary ? 0 : dest.cy > SOURCE_CY ? 0.4 : 0.2)
							}
							primary={dest.primary ?? false}
							reduced={reduced}
						/>
					)),
				)}

				<motion.foreignObject
					x={SOURCE_X - 52}
					y={SOURCE_CY - 26}
					width={104}
					height={52}
					initial={{ opacity: 0, x: SOURCE_X - 62 }}
					animate={{ opacity: 1, x: SOURCE_X - 52 }}
					transition={{ duration: 0.4, ease: "easeOut" }}
				>
					<div
						className="flex flex-col items-center justify-center w-full h-full rounded-lg bg-gray-2 border border-blue-500/30 px-2 gap-1"
						style={{
							boxShadow: "0 0 12px 2px rgba(59,130,246,0.18)",
						}}
					>
						<div className="flex items-center gap-1">
							<span
								className="inline-block w-2 h-2 rounded-full bg-red-500"
								style={
									reduced
										? undefined
										: {
												animation: "pulse 1.4s ease-in-out infinite",
											}
								}
							/>
							<span className="text-gray-12 font-medium leading-none text-[9px]">
								recording.mp4
							</span>
						</div>
					</div>
				</motion.foreignObject>

				{DESTINATIONS.map((dest, i) => (
					<motion.foreignObject
						key={dest.id}
						x={DEST_X + 8}
						y={dest.cy - 22}
						width={108}
						height={44}
						initial={{ opacity: 0, x: DEST_X + 0 }}
						animate={{ opacity: 1, x: DEST_X + 8 }}
						transition={{
							duration: 0.4,
							delay: reduced ? 0 : 0.5 + i * 0.1,
							ease: "easeOut",
						}}
					>
						<div
							className={clsx(
								"flex items-center gap-2 w-full h-full rounded-lg px-3 border",
								dest.primary
									? "bg-blue-500/10 border-blue-500/30 text-blue-500"
									: "bg-gray-2 border-gray-5 text-gray-10",
							)}
							style={
								dest.primary
									? { boxShadow: "0 0 10px 1px rgba(59,130,246,0.15)" }
									: undefined
							}
						>
							{dest.icon}
							<span className="text-[10px] font-medium leading-none">
								{dest.label}
							</span>
						</div>
					</motion.foreignObject>
				))}
			</svg>

			<style>{`
				@keyframes pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.3; }
				}
			`}</style>
		</div>
	);
};

export default StorageRoutingArt;
