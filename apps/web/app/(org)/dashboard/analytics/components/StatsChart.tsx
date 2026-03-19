"use client";

import { Check } from "lucide-react";
import { cloneElement, type SVGProps, useMemo, useRef, useState } from "react";
import {
	CapIcon,
	ChatIcon,
	ClapIcon,
	ReactionIcon,
} from "@/app/(org)/dashboard/_components/AnimatedIcons";
import { classNames } from "@/utils/helpers";
import type { CapIconHandle } from "../../_components/AnimatedIcons/Cap";
import ChartArea from "./ChartArea";

type boxes = "caps" | "views" | "comments" | "reactions";
type ChartPoint = {
	bucket: string;
	caps: number;
	views: number;
	comments: number;
	reactions: number;
};

const formatCount = (value: number) => {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return value.toLocaleString();
};

interface StatsChartProps {
	counts: Record<boxes, number>;
	data: ChartPoint[];
	isLoading?: boolean;
	capId?: string | null;
}

export default function StatsBox({
	counts,
	data,
	isLoading,
	capId,
}: StatsChartProps) {
	const [selectedBoxes, setSelectedBoxes] = useState<Set<boxes>>(
		new Set(["views", "comments", "reactions"]),
	);

	const capsBoxRef = useRef<CapIconHandle | null>(null);
	const viewsBoxRef = useRef<CapIconHandle | null>(null);
	const chatsBoxRef = useRef<CapIconHandle | null>(null);
	const reactionsBoxRef = useRef<CapIconHandle | null>(null);

	const toggleHandler = (box: boxes) => {
		setSelectedBoxes((prev) => {
			const next = new Set(prev);
			if (next.has(box)) {
				next.delete(box);
			} else {
				next.add(box);
			}
			return next;
		});
	};

	const formattedCounts = useMemo(
		() => ({
			caps: formatCount(counts.caps),
			views: formatCount(counts.views),
			comments: formatCount(counts.comments),
			reactions: formatCount(counts.reactions),
		}),
		[counts],
	);

	return (
		<div className="flex flex-col gap-4 px-8 pt-8 w-full rounded-xl border bg-gray-2 border-gray-3">
			<div className="flex flex-wrap gap-4">
				{isLoading ? (
					Array.from({ length: capId ? 3 : 4 }, (_, index) => (
						<StatBoxSkeleton key={`skeleton-${capId ? 3 : 4}-${index}`} />
					))
				) : (
					<>
						<StatBox
							onClick={() => toggleHandler("views")}
							isSelected={selectedBoxes.has("views")}
							title="Views"
							value={formattedCounts.views}
							metric="views"
							onMouseEnter={() => viewsBoxRef.current?.startAnimation()}
							onMouseLeave={() => viewsBoxRef.current?.stopAnimation()}
							icon={<ClapIcon ref={viewsBoxRef} size={20} />}
						/>
						<StatBox
							onClick={() => toggleHandler("comments")}
							isSelected={selectedBoxes.has("comments")}
							title="Comments"
							value={formattedCounts.comments}
							metric="comments"
							onMouseEnter={() => chatsBoxRef.current?.startAnimation()}
							onMouseLeave={() => chatsBoxRef.current?.stopAnimation()}
							icon={<ChatIcon ref={chatsBoxRef} size={20} />}
						/>
						<StatBox
							onClick={() => toggleHandler("reactions")}
							isSelected={selectedBoxes.has("reactions")}
							title="Reactions"
							value={formattedCounts.reactions}
							metric="reactions"
							onMouseEnter={() => reactionsBoxRef.current?.startAnimation()}
							onMouseLeave={() => reactionsBoxRef.current?.stopAnimation()}
							icon={<ReactionIcon ref={reactionsBoxRef} size={20} />}
						/>
						{!capId && (
							<StatBox
								onClick={() => toggleHandler("caps")}
								isSelected={selectedBoxes.has("caps")}
								title="Caps"
								value={formattedCounts.caps}
								metric="caps"
								onMouseEnter={() => capsBoxRef.current?.startAnimation()}
								onMouseLeave={() => capsBoxRef.current?.stopAnimation()}
								icon={<CapIcon ref={capsBoxRef} size={20} />}
							/>
						)}
					</>
				)}
			</div>
			<ChartArea
				selectedMetrics={Array.from(selectedBoxes).filter(
					(metric) => !capId || metric !== "caps",
				)}
				data={data}
				isLoading={isLoading}
			/>
		</div>
	);
}

const metricColors = {
	views: {
		bg: "rgba(59, 130, 246, 0.03)",
		bgHover: "rgba(59, 130, 246, 0.05)",
		bgSelected: "rgba(59, 130, 246, 0.08)",
		border: "rgba(59, 130, 246, 0.15)",
		borderSelected: "rgba(59, 130, 246, 0.25)",
	},
	comments: {
		bg: "rgba(236, 72, 153, 0.03)",
		bgHover: "rgba(236, 72, 153, 0.05)",
		bgSelected: "rgba(236, 72, 153, 0.08)",
		border: "rgba(236, 72, 153, 0.15)",
		borderSelected: "rgba(236, 72, 153, 0.25)",
	},
	reactions: {
		bg: "rgba(249, 115, 22, 0.03)",
		bgHover: "rgba(249, 115, 22, 0.05)",
		bgSelected: "rgba(249, 115, 22, 0.08)",
		border: "rgba(249, 115, 22, 0.15)",
		borderSelected: "rgba(249, 115, 22, 0.25)",
	},
	caps: {
		bg: "rgba(0, 0, 0, 0.02)",
		bgHover: "rgba(0, 0, 0, 0.03)",
		bgSelected: "rgba(0, 0, 0, 0.05)",
		border: "rgba(0, 0, 0, 0.12)",
		borderSelected: "rgba(0, 0, 0, 0.2)",
	},
} as const;

interface StatBoxProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	title: string;
	value: string;
	icon: React.ReactElement<SVGProps<SVGSVGElement>>;
	isSelected?: boolean;
	metric: boxes;
}
function StatBox({
	title,
	value,
	icon,
	isSelected = false,
	metric,
	...props
}: StatBoxProps) {
	const colors = metricColors[metric];

	return (
		<button
			{...props}
			type="button"
			className={classNames(
				"flex flex-col flex-1 min-w-[150px] gap-2 px-8 py-6 rounded-xl border transition-all duration-200 cursor-pointer group h-fit border-gray-5 text-left",
				isSelected ? "border-gray-8" : "",
			)}
			style={{
				backgroundColor: isSelected ? colors.bgSelected : colors.bg,
				borderColor: isSelected ? colors.borderSelected : colors.border,
			}}
			onMouseEnter={(e) => {
				if (!isSelected) {
					e.currentTarget.style.backgroundColor = colors.bgHover;
				}
				props.onMouseEnter?.(e);
			}}
			onMouseLeave={(e) => {
				if (!isSelected) {
					e.currentTarget.style.backgroundColor = colors.bg;
				}
				props.onMouseLeave?.(e);
			}}
		>
			<div className="flex gap-2 items-center h-fit justify-between">
				<div className="flex gap-2 items-center h-fit">
					{cloneElement(icon, {
						className: classNames(
							"group-hover:text-gray-12 transition-colors duration-200",
							isSelected ? "text-gray-12" : "text-gray-10",
						),
					})}
					<p
						className={classNames(
							"text-base font-medium transition-colors duration-200 group-hover:text-gray-12 text-gray-10",
							isSelected && "text-gray-12",
						)}
					>
						{title}
					</p>
				</div>
				<div
					className={classNames(
						"flex items-center justify-center size-5 rounded border transition-all duration-200",
						isSelected
							? "bg-gray-3 border-gray-9 dark:bg-gray-10 dark:border-gray-10"
							: "bg-transparent border-gray-8 group-hover:border-gray-10",
					)}
				>
					{isSelected && (
						<Check className="size-3.5 text-gray-12 dark:text-gray-1" />
					)}
				</div>
			</div>
			<p className="text-2xl font-medium transition-colors duration-200 text-gray-12">
				{value}
			</p>
		</button>
	);
}

function StatBoxSkeleton() {
	return (
		<div className="flex flex-col flex-1 min-w-[150px] gap-2 px-8 py-6 bg-transparent rounded-xl border border-gray-5 h-fit">
			<div className="flex gap-2 items-center h-fit">
				<div className="size-5 rounded bg-gray-4 animate-pulse" />
				<div className="h-4 w-20 rounded bg-gray-4 animate-pulse" />
			</div>
			<div className="h-8 w-16 rounded bg-gray-4 animate-pulse" />
		</div>
	);
}
