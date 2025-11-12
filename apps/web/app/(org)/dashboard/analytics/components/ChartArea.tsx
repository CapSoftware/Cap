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
		color: "var(--gray-12)",
	},
	comments: {
		label: "Comments",
		color: "#3b82f6",
	},
	reactions: {
		label: "Reactions",
		color: "#60a5fa",
	},
	caps: {
		label: "Caps",
		color: "#06b6d4",
	},
} satisfies ChartConfig;

interface ChartAreaProps {
	selectedMetric: "caps" | "views" | "comments" | "reactions";
	data: Array<{
		bucket: string;
		caps: number;
		views: number;
		comments: number;
		reactions: number;
	}>;
	isLoading?: boolean;
}

function ChartArea({ selectedMetric, data, isLoading }: ChartAreaProps) {
	const viewsGradientId = useId();
	const commentsGradientId = useId();
	const reactionsGradientId = useId();
	const capsGradientId = useId();
	const glowFilterId = useId();

	const chartData = useMemo(() => {
		if (!data || data.length === 0) return [];
		const bucketDuration =
			data.length > 1
				? new Date(data[1]!.bucket).getTime() - new Date(data[0]!.bucket).getTime()
				: 0;
		const hourly = bucketDuration > 0 && bucketDuration <= 60 * 60 * 1000;
		return data.map((point) => ({
			...point,
			label: formatBucketLabel(point.bucket, hourly),
		}));
	}, [data]);

	if (isLoading && chartData.length === 0) {
		return (
			<div className="h-[300px] w-full animate-pulse rounded-xl bg-gray-3" />
		);
	}

	if (chartData.length === 0) {
		return (
			<div className="flex h-[300px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-gray-5 text-sm text-gray-9">
				No analytics data yet.
			</div>
		);
	}

	return (
		<ChartContainer className="h-[500px]" config={chartConfig}>
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
					ticks={[0, 20, 40, 60, 80, 100]}
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
					{selectedMetric === "views" && (
						<linearGradient id={viewsGradientId} x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor="var(--gray-8)" stopOpacity={0.5} />
							<stop offset="95%" stopColor="var(--gray-8)" stopOpacity={0} />
						</linearGradient>
					)}
					{selectedMetric === "comments" && (
						<linearGradient id={commentsGradientId} x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor="#3b82f6" stopOpacity={0.5} />
							<stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
						</linearGradient>
					)}
					{selectedMetric === "reactions" && (
						<linearGradient
							id={reactionsGradientId}
							x1="0"
							y1="0"
							x2="0"
							y2="1"
						>
							<stop offset="5%" stopColor="#60a5fa" stopOpacity={0.5} />
							<stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
						</linearGradient>
					)}
					{selectedMetric === "caps" && (
						<linearGradient id={capsGradientId} x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor="#06b6d4" stopOpacity={0.5} />
							<stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
						</linearGradient>
					)}
				</defs>
				{selectedMetric === "views" && (
					<Area
						dataKey="views"
						type="monotone"
						fill={`url(#${viewsGradientId})`}
						fillOpacity={0.4}
						stroke="var(--gray-12)"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
				{selectedMetric === "comments" && (
					<Area
						dataKey="comments"
						type="monotone"
						fill={`url(#${commentsGradientId})`}
						fillOpacity={0.4}
						stroke="#3b82f6"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
				{selectedMetric === "reactions" && (
					<Area
						dataKey="reactions"
						type="monotone"
						fill={`url(#${reactionsGradientId})`}
						fillOpacity={0.4}
						stroke="#60a5fa"
						strokeWidth={1}
						filter={`url(#${glowFilterId})`}
					/>
				)}
				{selectedMetric === "caps" && (
					<Area
						dataKey="caps"
						type="monotone"
						fill={`url(#${capsGradientId})`}
						fillOpacity={0.4}
						stroke="#06b6d4"
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
