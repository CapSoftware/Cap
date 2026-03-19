"use client";

import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";

export const description = "An area chart with gradient fill";

const chartConfig = {
	views: {
		label: "Views",
		color: "#3b82f6",
	},
	comments: {
		label: "Comments",
		color: "#ec4899",
	},
	reactions: {
		label: "Reactions",
		color: "#f97316",
	},
	caps: {
		label: "Caps",
		color: "var(--gray-12)",
	},
} satisfies ChartConfig;

interface ChartAreaProps {
	selectedMetrics: Array<"caps" | "views" | "comments" | "reactions">;
	data: Array<{
		bucket: string;
		caps: number;
		views: number;
		comments: number;
		reactions: number;
	}>;
	isLoading?: boolean;
}

function ChartArea({ selectedMetrics, data, isLoading }: ChartAreaProps) {
	const viewsGradientId = useId();
	const commentsGradientId = useId();
	const reactionsGradientId = useId();
	const capsGradientId = useId();
	const glowFilterId = useId();

	const chartData = useMemo(() => {
		if (!data || data.length === 0) return [];
		const bucketDuration =
			data.length > 1 && data[1]?.bucket && data[0]?.bucket
				? new Date(data[1].bucket).getTime() -
					new Date(data[0].bucket).getTime()
				: 0;
		const hourly = bucketDuration > 0 && bucketDuration <= 60 * 60 * 1000;
		return data.map((point) => ({
			...point,
			label: formatBucketLabel(point.bucket, hourly),
		}));
	}, [data]);

	const { maxValue, yAxisTicks } = useMemo(() => {
		if (!chartData.length || selectedMetrics.length === 0) {
			return { maxValue: 100, yAxisTicks: [0, 20, 40, 60, 80, 100] };
		}

		let max = 0;
		for (const point of chartData) {
			for (const metric of selectedMetrics) {
				const value = point[metric] ?? 0;
				if (value > max) {
					max = value;
				}
			}
		}

		if (max === 0) {
			return { maxValue: 100, yAxisTicks: [0, 20, 40, 60, 80, 100] };
		}

		const roundedMax = Math.ceil(max * 1.1);
		const magnitude = 10 ** Math.floor(Math.log10(roundedMax));
		const normalized = roundedMax / magnitude;
		let niceMax: number;

		if (normalized <= 1) {
			niceMax = magnitude;
		} else if (normalized <= 2) {
			niceMax = 2 * magnitude;
		} else if (normalized <= 5) {
			niceMax = 5 * magnitude;
		} else {
			niceMax = 10 * magnitude;
		}

		const step = niceMax / 5;
		const ticks: number[] = [];
		for (let i = 0; i <= 5; i++) {
			ticks.push(Math.round(i * step));
		}

		return { maxValue: niceMax, yAxisTicks: ticks };
	}, [chartData, selectedMetrics]);

	if (isLoading && chartData.length === 0) {
		return (
			<div className="h-[500px] w-full animate-pulse rounded-xl border bg-gray-2 border-gray-3" />
		);
	}

	if (chartData.length === 0) {
		return (
			<div className="flex h-[300px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-gray-5 text-sm text-gray-9">
				No analytics data yet.
			</div>
		);
	}

	if (selectedMetrics.length === 0) {
		return (
			<div className="flex h-[300px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-gray-5 text-sm text-gray-9">
				Select at least one metric to view.
			</div>
		);
	}

	return (
		<ChartContainer className="h-[500px] bg-gray-2" config={chartConfig}>
			<AreaChart
				accessibilityLayer
				data={chartData}
				margin={{
					left: 20,
					right: 20,
					top: 20,
					bottom: 10,
				}}
			>
				<CartesianGrid
					vertical={false}
					strokeDasharray="3 3"
					stroke="var(--gray-8)"
					opacity={0.3}
				/>
				<XAxis
					dataKey="label"
					axisLine={false}
					tickMargin={10}
					interval={0}
					height={40}
					tick={{ fontSize: 11 }}
				/>
				<YAxis
					axisLine={false}
					tickMargin={8}
					ticks={yAxisTicks}
					domain={[0, maxValue]}
					width={16}
					allowDataOverflow={false}
				/>
				<ChartTooltip content={<ChartTooltipContent />} />
				<defs>
					<filter id={glowFilterId}>
						<feGaussianBlur stdDeviation="2" result="coloredBlur" />
						<feMerge>
							<feMergeNode in="coloredBlur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
					<linearGradient id={viewsGradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="5%" stopColor="#3b82f6" stopOpacity={0.5} />
						<stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
					</linearGradient>
					<linearGradient id={commentsGradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="5%" stopColor="#ec4899" stopOpacity={0.5} />
						<stop offset="95%" stopColor="#ec4899" stopOpacity={0} />
					</linearGradient>
					<linearGradient id={reactionsGradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="5%" stopColor="#f97316" stopOpacity={0.5} />
						<stop offset="95%" stopColor="#f97316" stopOpacity={0} />
					</linearGradient>
					<linearGradient id={capsGradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="5%" stopColor="var(--gray-12)" stopOpacity={0.5} />
						<stop offset="95%" stopColor="var(--gray-12)" stopOpacity={0} />
					</linearGradient>
				</defs>
				{selectedMetrics.includes("views") && (
					<Area
						dataKey="views"
						type="monotone"
						fill={`url(#${viewsGradientId})`}
						fillOpacity={0.4}
						stroke="#3b82f6"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
				{selectedMetrics.includes("comments") && (
					<Area
						dataKey="comments"
						type="monotone"
						fill={`url(#${commentsGradientId})`}
						fillOpacity={0.4}
						stroke="#ec4899"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
				{selectedMetrics.includes("reactions") && (
					<Area
						dataKey="reactions"
						type="monotone"
						fill={`url(#${reactionsGradientId})`}
						fillOpacity={0.4}
						stroke="#f97316"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
				{selectedMetrics.includes("caps") && (
					<Area
						dataKey="caps"
						type="monotone"
						fill={`url(#${capsGradientId})`}
						fillOpacity={0.4}
						stroke="var(--gray-12)"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
			</AreaChart>
		</ChartContainer>
	);
}

export default ChartArea;

const formatBucketLabel = (bucket: string, hourly: boolean) => {
	const date = new Date(bucket);
	if (Number.isNaN(date.getTime())) return bucket;
	if (hourly)
		return date.toLocaleTimeString([], {
			hour: "numeric",
			minute: undefined,
		});
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
};
