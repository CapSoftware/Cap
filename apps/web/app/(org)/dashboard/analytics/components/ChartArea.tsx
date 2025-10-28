"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";

export const description = "An area chart with gradient fill";

const chartData = Array.from({ length: 24 }, (_, i) => ({
	hour: i + 1,
	desktop: Math.floor(Math.random() * 100).toFixed(0),
}));

const chartConfig = {
	desktop: {
		label: "Desktop",
		color: "var(--gray-12)",
	},
} satisfies ChartConfig;

function ChartArea() {
	const desktopGradientId = useId();
	const glowFilterId = useId();

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
					dataKey="hour"
					axisLine={false}
					tickMargin={10}
					interval={0}
					height={40}
					tick={{ fontSize: 11 }}
				/>
				<YAxis
					axisLine={false}
					tickMargin={8}
					domain={[0, 100]}
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
					<linearGradient id={desktopGradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="var(--gray-8)" stopOpacity={0.6} />
						<stop offset="95%" stopColor="var(--gray-8)" stopOpacity={0} />
					</linearGradient>
				</defs>
				<Area
					dataKey="desktop"
					type="natural"
					fill={`url(#${desktopGradientId})`}
					fillOpacity={1}
					stroke="var(--gray-12)"
					strokeWidth={1}
					filter={`url(#${glowFilterId})`}
				/>
			</AreaChart>
		</ChartContainer>
	);
}

export default ChartArea;
