"use client";

import NumberFlow from "@number-flow/react";
import clsx from "clsx";
import { type ReactNode, useMemo, useState } from "react";
import {
	BubbleDoodle,
	EyeDoodle,
	PaperPlaneDoodle,
	ReelDoodle,
	SmileDoodle,
	SquiggleLoader,
} from "./Doodles";
import type { Granularity } from "./format";
import TrafficChart, {
	type ChartPoint,
	METRIC_META,
	type Metric,
} from "./TrafficChart";

interface StatsChartProps {
	counts: Record<Metric, number>;
	data: ChartPoint[];
	isLoading?: boolean;
	capId?: string | null;
	granularity: Granularity;
	animationKey: string;
	emptyAction?: ReactNode;
}

const DOODLES: Record<Metric, () => ReactNode> = {
	views: () => <EyeDoodle />,
	comments: () => <BubbleDoodle />,
	reactions: () => <SmileDoodle />,
	caps: () => <ReelDoodle />,
};

export default function StatsChart({
	counts,
	data,
	isLoading,
	capId,
	granularity,
	animationKey,
	emptyAction,
}: StatsChartProps) {
	const available: Metric[] = capId
		? ["views", "comments", "reactions"]
		: ["views", "comments", "reactions", "caps"];
	const [selected, setSelected] = useState<Set<Metric>>(
		() => new Set<Metric>(["views", "comments", "reactions"]),
	);

	const withVisibleMetric = (set: Set<Metric>) =>
		available.some((m) => set.has(m)) ? set : new Set<Metric>(["views"]);
	const effective = withVisibleMetric(selected);

	const toggle = (metric: Metric) => {
		setSelected((prev) => {
			const next = new Set(withVisibleMetric(prev));
			if (next.has(metric)) {
				const visibleCount = available.filter((m) => next.has(m)).length;
				if (visibleCount > 1) next.delete(metric);
			} else {
				next.add(metric);
			}
			return next;
		});
	};

	const metrics = available.filter((m) => effective.has(m));
	const display = useMemo(
		() => rollUpLongRanges(data, granularity),
		[data, granularity],
	);
	const completeBuckets = Math.max(1, data.length - 1);
	const perUnit = granularity === "hour" ? "an hour" : "a day";

	const hints = useMemo<Record<Metric, string>>(() => {
		const per100 = (value: number) =>
			counts.views > 0
				? `${((value / counts.views) * 100).toFixed(1).replace(/\.0$/, "")} per 100 views`
				: "No views yet";
		const avg = (value: number) => {
			const v = value / completeBuckets;
			if (value === 0) return "None yet";
			return `About ${v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1).replace(/\.0$/, "")} ${perUnit}`;
		};
		return {
			views: avg(counts.views),
			comments: per100(counts.comments),
			reactions: per100(counts.reactions),
			caps: counts.caps === 0 ? "None yet" : avg(counts.caps),
		};
	}, [counts, completeBuckets, perUnit]);

	const hasActivity = data.some(
		(p) => p.views > 0 || p.comments > 0 || p.reactions > 0 || p.caps > 0,
	);

	return (
		<section className="overflow-hidden w-full rounded-2xl border shadow-[0_1px_2px_rgba(0,0,0,0.04)] bg-gray-1 border-gray-4">
			<div
				className={clsx(
					"grid gap-px border-b bg-gray-3 border-gray-3",
					available.length === 4
						? "grid-cols-2 lg:grid-cols-4"
						: "grid-cols-1 sm:grid-cols-3",
				)}
			>
				{available.map((metric) => (
					<StatTile
						key={metric}
						metric={metric}
						value={counts[metric]}
						hint={hints[metric]}
						isSelected={effective.has(metric)}
						isLoading={isLoading}
						onClick={() => toggle(metric)}
					/>
				))}
			</div>
			<div className="px-3 pt-4 pb-3 sm:px-5">
				{isLoading ? (
					<div className="flex h-[340px] flex-col items-center justify-center gap-3">
						<SquiggleLoader />
						<p className="text-sm text-gray-10">Counting views…</p>
					</div>
				) : !hasActivity ? (
					<div className="flex h-[340px] flex-col items-center justify-center text-center">
						<PaperPlaneDoodle />
						<p className="mt-5 text-lg font-medium text-gray-12">
							No views in this period
						</p>
						<p className="mt-1 max-w-sm text-sm text-gray-10 text-pretty">
							{capId
								? "Send this Cap to someone and every view, comment and reaction will land here."
								: "Share a Cap and every view, comment and reaction will land here."}
						</p>
						{emptyAction && <div className="mt-5">{emptyAction}</div>}
					</div>
				) : (
					<TrafficChart
						data={display.data}
						metrics={metrics}
						granularity={display.granularity}
						animationKey={`${animationKey}-${display.data.length}-${display.data[0]?.bucket ?? ""}`}
					/>
				)}
			</div>
		</section>
	);
}

const WEEKLY_THRESHOLD = 92;

const rollUpLongRanges = (
	data: ChartPoint[],
	granularity: Granularity,
): { data: ChartPoint[]; granularity: Granularity } => {
	if (granularity !== "day" || data.length <= WEEKLY_THRESHOLD) {
		return { data, granularity };
	}
	const weeks: ChartPoint[] = [];
	for (let end = data.length; end > 0; end -= 7) {
		const chunk = data.slice(Math.max(0, end - 7), end);
		const first = chunk[0];
		const last = chunk[chunk.length - 1];
		if (!first || !last) continue;
		weeks.unshift(
			chunk.reduce(
				(acc, point) => ({
					bucket: acc.bucket,
					bucketEnd: acc.bucketEnd,
					views: acc.views + point.views,
					comments: acc.comments + point.comments,
					reactions: acc.reactions + point.reactions,
					caps: acc.caps + point.caps,
				}),
				{
					bucket: first.bucket,
					bucketEnd: last.bucket,
					views: 0,
					comments: 0,
					reactions: 0,
					caps: 0,
				},
			),
		);
	}
	return { data: weeks, granularity: "week" };
};

function StatTile({
	metric,
	value,
	hint,
	isSelected,
	isLoading,
	onClick,
}: {
	metric: Metric;
	value: number;
	hint: string;
	isSelected: boolean;
	isLoading?: boolean;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const meta = METRIC_META[metric];

	return (
		<button
			type="button"
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setHovered(true)}
			onBlur={() => setHovered(false)}
			aria-pressed={isSelected}
			data-doodle-hover={hovered ? "" : undefined}
			className={clsx(
				"group relative flex flex-col gap-1 px-6 py-5 text-left transition-colors duration-200 outline-none bg-gray-1 focus-visible:bg-gray-2 hover:bg-gray-2",
			)}
		>
			<div className="flex justify-between items-center">
				<div className="flex gap-2 items-center">
					<span className="-ml-1 flex size-7 items-center justify-center">
						{DOODLES[metric]()}
					</span>
					<span
						className={clsx(
							"text-sm font-medium transition-colors",
							isSelected ? "text-gray-12" : "text-gray-10",
						)}
					>
						{meta.label}
					</span>
				</div>
				<span
					className={clsx(
						"flex size-4 items-center justify-center rounded-[5px] border-[1.5px] transition-all duration-200",
						!isSelected && "border-gray-7 group-hover:border-gray-9",
					)}
					style={
						isSelected
							? { background: meta.color, borderColor: meta.color }
							: undefined
					}
					aria-hidden="true"
				>
					{isSelected && (
						<svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
							<path
								d="M2.5 6.2 5 8.5 9.5 3.5"
								fill="none"
								stroke="white"
								strokeWidth={1.8}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					)}
				</span>
			</div>
			{isLoading ? (
				<>
					<div className="mt-1.5 h-8 w-20 rounded-md animate-pulse bg-gray-3" />
					<div className="mt-1 h-3.5 w-28 rounded animate-pulse bg-gray-3" />
				</>
			) : (
				<>
					<NumberFlow
						value={value}
						format={value >= 10_000 ? { notation: "compact" } : undefined}
						className={clsx(
							"text-[32px] font-semibold leading-tight tracking-tight tabular-nums transition-colors",
							isSelected ? "text-gray-12" : "text-gray-9",
						)}
					/>
					<span className="text-[13px] text-gray-10">{hint}</span>
				</>
			)}
		</button>
	);
}
