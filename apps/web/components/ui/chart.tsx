"use client";

import { cx } from "class-variance-authority";
import * as React from "react";
import * as RechartsPrimitive from "recharts";

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const;

export type ChartConfig = {
	[k in string]: {
		label?: React.ReactNode;
		icon?: React.ComponentType;
	} & (
		| { color?: string; theme?: never }
		| { color?: never; theme: Record<keyof typeof THEMES, string> }
	);
};

type ChartContextProps = {
	config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
	const context = React.useContext(ChartContext);

	if (!context) {
		throw new Error("useChart must be used within a <ChartContainer />");
	}

	return context;
}

const ChartContainer = React.forwardRef<
	HTMLDivElement,
	React.ComponentProps<"div"> & {
		config: ChartConfig;
		children: React.ComponentProps<
			typeof RechartsPrimitive.ResponsiveContainer
		>["children"];
	}
>(({ id, className, children, config, ...props }, ref) => {
	const uniqueId = React.useId();
	const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;

	return (
		<ChartContext.Provider value={{ config }}>
			<div
				data-chart={chartId}
				ref={ref}
				className={cx(
					"flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-gray-11 [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-gray-5/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-gray-5 [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-gray-5 [&_.recharts-radial-bar-background-sector]:fill-gray-3 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-gray-5 [&_.recharts-reference-line_[stroke='#ccc']]:stroke-gray-5 [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
					className,
				)}
				{...props}
			>
				<ChartStyle id={chartId} config={config} />
				<RechartsPrimitive.ResponsiveContainer>
					{children}
				</RechartsPrimitive.ResponsiveContainer>
			</div>
		</ChartContext.Provider>
	);
});
ChartContainer.displayName = "ChartContainer";

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
	const colorConfig = Object.entries(config).filter(
		([_, config]) => config.theme || config.color,
	);

	if (!colorConfig.length) {
		return null;
	}

	return (
		<style
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Required for dynamic chart theming
			dangerouslySetInnerHTML={{
				__html: Object.entries(THEMES)
					.map(
						([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
	.map(([key, itemConfig]) => {
		const color =
			itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ||
			itemConfig.color;
		return color ? `  --color-${key}: ${color};` : null;
	})
	.join("\n")}
}
`,
					)
					.join("\n"),
			}}
		/>
	);
};

const ChartTooltip = RechartsPrimitive.Tooltip;

interface ChartTooltipContentProps extends React.ComponentProps<"div"> {
	active?: boolean;
	payload?: Array<{
		name?: string;
		value?: number | string;
		color?: string;
		dataKey?: string;
		payload?: Record<string, unknown>;
		fill?: string;
	}>;
	label?: string;
	hideLabel?: boolean;
	hideIndicator?: boolean;
	indicator?: "line" | "dot" | "dashed";
	nameKey?: string;
	labelKey?: string;
	labelFormatter?: (label: unknown, payload: unknown[]) => React.ReactNode;
	labelClassName?: string;
	formatter?: (
		value: unknown,
		name: unknown,
		item: unknown,
		index: number,
		payload: unknown,
	) => React.ReactNode;
	color?: string;
}

const ChartTooltipContent = React.forwardRef<
	HTMLDivElement,
	ChartTooltipContentProps
>(
	(
		{
			active,
			payload,
			className,
			indicator = "dot",
			hideLabel = false,
			hideIndicator = false,
			label,
			labelFormatter,
			labelClassName,
			formatter,
			color,
			nameKey,
			labelKey,
		},
		ref,
	) => {
		const { config } = useChart();

		const tooltipLabel = React.useMemo(() => {
			if (hideLabel || !payload?.length) {
				return null;
			}

			const [item] = payload;
			if (!item) return null;

			const key = `${labelKey || item.dataKey || item.name || "value"}`;
			const itemConfig = config[key as keyof typeof config];
			const value =
				!labelKey && typeof label === "string"
					? config[label as keyof typeof config]?.label || label
					: itemConfig?.label;

			if (labelFormatter) {
				return (
					<div className={cx("font-medium text-gray-12", labelClassName)}>
						{labelFormatter(value, payload)}
					</div>
				);
			}

			if (!value) {
				return null;
			}

			return (
				<div className={cx("font-medium text-gray-12", labelClassName)}>
					{value}
				</div>
			);
		}, [
			label,
			labelFormatter,
			payload,
			hideLabel,
			labelClassName,
			config,
			labelKey,
		]);

		if (!active || !payload?.length) {
			return null;
		}

		const nestLabel = payload.length === 1 && indicator !== "dot";

		return (
			<div
				ref={ref}
				className={cx(
					"grid min-w-[8rem] items-start gap-1 rounded-lg border border-gray-5 bg-gray-1 px-2.5 py-1.5 text-xs shadow-xl",
					className,
				)}
			>
				{!nestLabel ? tooltipLabel : null}
				<div className="grid gap-1">
					{payload.map((item, index) => {
						const key = `${nameKey || item.name || item.dataKey || "value"}`;
						const itemConfig = config[key as keyof typeof config];
						const indicatorColor = color || item.payload?.fill || item.color;

						return (
							<div
								key={item.dataKey}
								className={cx(
									"flex w-full flex-wrap gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-gray-11",
									indicator === "dot" ? "items-center" : "items-stretch",
								)}
							>
								{formatter && item?.value !== undefined && item.name ? (
									formatter(item.value, item.name, item, index, item.payload)
								) : (
									<>
										{itemConfig?.icon ? (
											<itemConfig.icon />
										) : (
											!hideIndicator && (
												<div
													className={cx(
														"shrink-0 rounded-[2px] border-[--color-border] bg-[--color-bg]",
														{
															"h-2.5 w-2.5": indicator === "dot",
															"w-1": indicator === "line",
															"w-0 border-[1.5px] border-dashed bg-transparent":
																indicator === "dashed",
															"my-0.5": nestLabel && indicator === "dashed",
														},
													)}
													style={
														{
															"--color-bg": indicatorColor,
															"--color-border": indicatorColor,
														} as React.CSSProperties
													}
												/>
											)
										)}
										<div
											className={cx(
												"flex flex-1 justify-between leading-none",
												nestLabel ? "items-end" : "items-center",
											)}
										>
											<div className="grid gap-1">
												{nestLabel ? tooltipLabel : null}
												<span className="leading-none text-gray-12">
													{itemConfig?.label || item.name}
												</span>
											</div>
											{item.value && (
												<span className="font-mono font-medium tabular-nums leading-none text-gray-12">
													{item.value.toLocaleString()}
												</span>
											)}
										</div>
									</>
								)}
							</div>
						);
					})}
				</div>
			</div>
		);
	},
);
ChartTooltipContent.displayName = "ChartTooltipContent";

const ChartLegend = RechartsPrimitive.Legend;

interface ChartLegendContentProps extends React.ComponentProps<"div"> {
	payload?: Array<{
		value?: string;
		dataKey?: string;
		color?: string;
	}>;
	verticalAlign?: "top" | "bottom";
	hideIcon?: boolean;
	nameKey?: string;
}

const ChartLegendContent = React.forwardRef<
	HTMLDivElement,
	ChartLegendContentProps
>(
	(
		{ className, hideIcon = false, payload, verticalAlign = "bottom", nameKey },
		ref,
	) => {
		const { config } = useChart();

		if (!payload?.length) {
			return null;
		}

		return (
			<div
				ref={ref}
				className={cx(
					"flex items-center justify-center gap-4",
					verticalAlign === "top" ? "pb-3" : "pt-3",
					className,
				)}
			>
				{payload.map((item) => {
					const key = `${nameKey || item.dataKey || "value"}`;
					const itemConfig = config[key as keyof typeof config];

					return (
						<div
							key={item.value}
							className={cx(
								"flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-gray-11",
							)}
						>
							{itemConfig?.icon && !hideIcon ? (
								<itemConfig.icon />
							) : (
								<div
									className="h-2 w-2 shrink-0 rounded-[2px]"
									style={{
										backgroundColor: item.color,
									}}
								/>
							)}
							<span className="text-gray-11">{itemConfig?.label}</span>
						</div>
					);
				})}
			</div>
		);
	},
);
ChartLegendContent.displayName = "ChartLegendContent";

export {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	ChartLegend,
	ChartLegendContent,
	ChartStyle,
};
