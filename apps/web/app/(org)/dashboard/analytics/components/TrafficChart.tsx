"use client";

import {
	type KeyboardEvent,
	type PointerEvent,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import styles from "./chart.module.css";
import { BOIL_FILTER_LARGE_ID, cx, doodleStyles, timing } from "./Doodles";
import {
	formatBucketTick,
	formatBucketTitle,
	formatCompact,
	formatRelative,
	type Granularity,
} from "./format";

export type Metric = "views" | "comments" | "reactions" | "caps";

export type ChartPoint = {
	bucket: string;
	bucketEnd?: string;
	caps: number;
	views: number;
	comments: number;
	reactions: number;
};

export const METRIC_META: Record<
	Metric,
	{ label: string; color: string; kind: "line" | "bar" }
> = {
	views: { label: "Views", color: "#4785ff", kind: "line" },
	caps: { label: "Caps created", color: "var(--gray-11)", kind: "line" },
	comments: { label: "Comments", color: "#f0805f", kind: "bar" },
	reactions: { label: "Reactions", color: "#f5b546", kind: "bar" },
};

const HEIGHT = 340;
const MARGIN = { top: 30, bottom: 34, left: 44 };

type Point = { x: number; y: number };

const niceTicks = (max: number, count = 4) => {
	if (max <= 0) return [0, 1, 2, 3, 4];
	const raw = max / count;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	const normalized = raw / magnitude;
	let nice: number;
	if (normalized <= 1) nice = 1;
	else if (normalized <= 2) nice = 2;
	else if (normalized <= 2.5 && magnitude >= 10) nice = 2.5;
	else if (normalized <= 5) nice = 5;
	else nice = 10;
	const step = Math.max(1, nice * magnitude);
	const top = Math.ceil(max / step) * step;
	const ticks: number[] = [];
	for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
	return ticks;
};

const monotoneSegments = (points: Point[]) => {
	const n = points.length;
	if (n < 2) return [] as string[];
	const slopes: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		const a = points[i] as Point;
		const b = points[i + 1] as Point;
		slopes.push((b.y - a.y) / (b.x - a.x || 1));
	}
	const tangents: number[] = [];
	for (let i = 0; i < n; i++) {
		if (i === 0) tangents.push(slopes[0] ?? 0);
		else if (i === n - 1) tangents.push(slopes[n - 2] ?? 0);
		else {
			const s0 = slopes[i - 1] ?? 0;
			const s1 = slopes[i] ?? 0;
			if (s0 * s1 <= 0) tangents.push(0);
			else {
				const t = (s0 + s1) / 2;
				const limit = 3 * Math.min(Math.abs(s0), Math.abs(s1));
				tangents.push(Math.sign(t) * Math.min(Math.abs(t), limit));
			}
		}
	}
	const segments: string[] = [];
	for (let i = 0; i < n - 1; i++) {
		const a = points[i] as Point;
		const b = points[i + 1] as Point;
		const h = (b.x - a.x) / 3;
		const ta = tangents[i] ?? 0;
		const tb = tangents[i + 1] ?? 0;
		segments.push(
			`C ${a.x + h} ${a.y + ta * h} ${b.x - h} ${b.y - tb * h} ${b.x} ${b.y}`,
		);
	}
	return segments;
};

const roundedTopRect = (
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) => {
	const radius = Math.min(r, w / 2, h);
	return `M ${x} ${y + h} L ${x} ${y + radius} Q ${x} ${y} ${x + radius} ${y} L ${x + w - radius} ${y} Q ${x + w} ${y} ${x + w} ${y + radius} L ${x + w} ${y + h} Z`;
};

const sketchLoop = (cx0: number, cy0: number, rx: number, ry: number) => {
	const parts: string[] = [];
	const start = -2.6;
	const sweep = Math.PI * 2 + 0.55;
	const steps = 34;
	for (let i = 0; i <= steps; i++) {
		const a = start + (sweep * i) / steps;
		const wobble = 1 + 0.07 * Math.sin(a * 3 + 0.8) + (i / steps) * 0.12;
		const x = cx0 + Math.cos(a) * rx * wobble;
		const y = cy0 + Math.sin(a) * ry * wobble;
		parts.push(`${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`);
	}
	return parts.join(" ");
};

function useWidth<T extends HTMLElement>() {
	const ref = useRef<T | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width] as const;
}

interface TrafficChartProps {
	data: ChartPoint[];
	metrics: Metric[];
	granularity: Granularity;
	animationKey: string;
}

export default function TrafficChart({
	data,
	metrics,
	granularity,
	animationKey,
}: TrafficChartProps) {
	const [containerRef, width] = useWidth<HTMLDivElement>();
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	const baseId = useId().replace(/[^a-zA-Z0-9]/g, "");
	const areaGradientId = `${baseId}-area`;
	const activeClipId = `${baseId}-active`;
	const restClipId = `${baseId}-rest`;

	const lineMetrics = metrics.filter((m) => METRIC_META[m].kind === "line");
	const barMetrics = metrics.filter((m) => METRIC_META[m].kind === "bar");
	const hasBarData = data.some((point) => barMetrics.some((m) => point[m] > 0));
	const barsOnRightAxis =
		lineMetrics.length > 0 && barMetrics.length > 0 && hasBarData;
	const marginRight = barsOnRightAxis ? 44 : 16;

	const n = data.length;
	const plotW = Math.max(0, width - MARGIN.left - marginRight);
	const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
	const step = n > 0 ? plotW / n : 0;
	const xAt = (i: number) => MARGIN.left + step * (i + 0.5);
	const baseline = MARGIN.top + plotH;

	const lineTicks = useMemo(() => {
		let max = 0;
		for (const point of data)
			for (const m of lineMetrics) max = Math.max(max, point[m]);
		return niceTicks(max);
	}, [data, lineMetrics]);

	const barTicks = useMemo(() => {
		let max = 0;
		for (const point of data) {
			let total = 0;
			for (const m of barMetrics) total += point[m];
			max = Math.max(max, total);
		}
		return niceTicks(lineMetrics.length > 0 ? max * 2 : max);
	}, [data, barMetrics, lineMetrics.length]);

	const lineMax = lineTicks[lineTicks.length - 1] || 1;
	const barMax = barTicks[barTicks.length - 1] || 1;
	const yLine = (v: number) => baseline - (v / lineMax) * plotH;
	const yBar = (v: number) => baseline - (v / barMax) * plotH;
	const leftTicks = lineMetrics.length > 0 ? lineTicks : barTicks;
	const yLeft = lineMetrics.length > 0 ? yLine : yBar;

	const series = useMemo(
		() =>
			lineMetrics.map((metric) => {
				const points = data.map((point, i) => ({
					x: MARGIN.left + step * (i + 0.5),
					y: baseline - (point[metric] / lineMax) * plotH,
				}));
				const segments = monotoneSegments(points);
				const first = points[0];
				const last = points[points.length - 1];
				const solid =
					first && segments.length > 1
						? `M ${first.x} ${first.y} ${segments.slice(0, -1).join(" ")}`
						: null;
				const penultimate = points[points.length - 2];
				const partial =
					penultimate && segments.length > 0
						? `M ${penultimate.x} ${penultimate.y} ${segments[segments.length - 1]}`
						: null;
				const area =
					first && last && segments.length > 0
						? `M ${first.x} ${first.y} ${segments.join(" ")} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`
						: null;
				return { metric, points, solid, partial, area };
			}),
		[data, lineMetrics, step, baseline, lineMax, plotH],
	);

	const tickIndices = useMemo(() => {
		if (n === 0 || plotW <= 0) return [] as number[];
		const maxLabels = Math.max(2, Math.floor(plotW / 78));
		const stride = Math.max(1, Math.ceil(n / maxLabels));
		const indices: number[] = [];
		for (let i = n - 1; i >= 0; i -= stride) indices.unshift(i);
		return indices;
	}, [n, plotW]);

	const spanDays = useMemo(() => {
		const first = data[0];
		const last = data[data.length - 1];
		if (!first || !last) return 0;
		return (
			(new Date(last.bucket).getTime() - new Date(first.bucket).getTime()) /
			(24 * 60 * 60 * 1000)
		);
	}, [data]);

	const peak = useMemo(() => {
		const metric = lineMetrics.includes("views") ? "views" : lineMetrics[0];
		if (!metric || n < 3) return null;
		let max = 0;
		let index = -1;
		let ties = 0;
		data.forEach((point, i) => {
			if (point[metric] > max) {
				max = point[metric];
				index = i;
				ties = 1;
			} else if (point[metric] === max && max > 0) {
				ties++;
			}
		});
		if (index < 0 || max < 2 || ties > 1) return null;
		return { metric, index, value: max };
	}, [data, lineMetrics, n]);

	const average = useMemo(() => {
		const complete = data.slice(0, -1);
		if (complete.length === 0) return 0;
		return complete.reduce((sum, p) => sum + p.views, 0) / complete.length;
	}, [data]);

	const indexFromClientX = (clientX: number, rect: DOMRect) => {
		if (n === 0 || step <= 0) return null;
		const x = clientX - rect.left - MARGIN.left;
		return Math.max(0, Math.min(n - 1, Math.floor(x / step)));
	};

	const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) return;
		setHoverIndex(indexFromClientX(event.clientX, svg.getBoundingClientRect()));
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (n === 0) return;
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const delta = event.key === "ArrowRight" ? 1 : -1;
			setHoverIndex((current) => {
				const start = current ?? (delta > 0 ? -1 : n);
				return Math.max(0, Math.min(n - 1, start + delta));
			});
		} else if (event.key === "Escape") {
			setHoverIndex(null);
		}
	};

	const hovered = hoverIndex !== null ? data[hoverIndex] : undefined;
	const hoverX = hoverIndex !== null ? xAt(hoverIndex) : null;
	const isLastBucket = hoverIndex !== null && hoverIndex === n - 1;
	const barWidth = Math.max(2, Math.min(22, step * 0.56));
	const ready = width > 0 && n > 0;

	const tooltipWidth = Math.max(0, Math.min(236, width - 16));
	const tooltipPreferred =
		hoverX === null
			? 0
			: hoverX + 18 + tooltipWidth > width
				? hoverX - 18 - tooltipWidth
				: hoverX + 18;
	const tooltipLeft = Math.max(
		8,
		Math.min(width - tooltipWidth - 8, tooltipPreferred),
	);

	const ratio =
		hovered && average > 0 && !isLastBucket ? hovered.views / average : 0;

	const peakPoint =
		peak && series.find((s) => s.metric === peak.metric)?.points[peak.index];

	return (
		<div
			ref={containerRef}
			className="relative w-full rounded-lg outline-none select-none focus-visible:ring-2 focus-visible:ring-blue-9/40"
			style={{ height: HEIGHT }}
			tabIndex={0}
			role="slider"
			aria-label="Activity over time"
			aria-valuemin={0}
			aria-valuemax={Math.max(0, n - 1)}
			aria-valuenow={hoverIndex ?? Math.max(0, n - 1)}
			aria-valuetext={
				hovered
					? `${formatBucketTitle(hovered.bucket, granularity, hovered.bucketEnd)}: ${metrics
							.map((m) => `${hovered[m]} ${METRIC_META[m].label.toLowerCase()}`)
							.join(", ")}`
					: "Use the left and right arrow keys to move between points"
			}
			onKeyDown={onKeyDown}
			onBlur={() => setHoverIndex(null)}
		>
			{ready && (
				<svg
					width={width}
					height={HEIGHT}
					className="overflow-visible"
					aria-hidden="true"
				>
					<defs>
						<linearGradient id={areaGradientId} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#4785ff" stopOpacity={0.22} />
							<stop offset="100%" stopColor="#4785ff" stopOpacity={0} />
						</linearGradient>
						<clipPath id={activeClipId}>
							<rect
								x={0}
								y={0}
								width={hoverX === null ? width : hoverX}
								height={HEIGHT}
							/>
						</clipPath>
						<clipPath id={restClipId}>
							<rect
								x={hoverX ?? width}
								y={0}
								width={Math.max(0, width - (hoverX ?? width))}
								height={HEIGHT}
							/>
						</clipPath>
					</defs>

					{leftTicks.map((tick) => (
						<g key={`l-${tick}`}>
							<line
								x1={MARGIN.left}
								x2={MARGIN.left + plotW}
								y1={yLeft(tick)}
								y2={yLeft(tick)}
								stroke="var(--gray-5)"
								strokeDasharray={tick === 0 ? undefined : "3 5"}
								strokeWidth={1}
							/>
							<text
								x={MARGIN.left - 12}
								y={yLeft(tick)}
								dy="0.32em"
								textAnchor="end"
								className="fill-gray-9 text-[11px] tabular-nums"
							>
								{formatCompact(tick)}
							</text>
						</g>
					))}

					{barsOnRightAxis &&
						barTicks.map((tick) => (
							<text
								key={`r-${tick}`}
								x={MARGIN.left + plotW + 12}
								y={yBar(tick)}
								dy="0.32em"
								className="fill-gray-9 text-[11px] tabular-nums"
							>
								{formatCompact(tick)}
							</text>
						))}

					<g key={`bars-${animationKey}`}>
						{data.map((point, i) => {
							let offset = 0;
							const visible = barMetrics.filter((m) => point[m] > 0);
							const dimmed = hoverIndex !== null && hoverIndex !== i;
							return visible.map((metric, j) => {
								const value = point[metric];
								const y0 = yBar(offset);
								offset += value;
								const y1 = yBar(offset);
								const isTop = j === visible.length - 1;
								const x = xAt(i) - barWidth / 2;
								const h = Math.max(1.5, y0 - y1);
								return (
									<path
										key={`${point.bucket}-${metric}`}
										className={styles.bar}
										style={{
											...timing(0.25 + (i / Math.max(1, n)) * 0.6),
											opacity: dimmed ? 0.45 : 1,
										}}
										d={
											isTop
												? roundedTopRect(x, y0 - h, barWidth, h, 4)
												: `M ${x} ${y0} L ${x} ${y0 - h} L ${x + barWidth} ${y0 - h} L ${x + barWidth} ${y0} Z`
										}
										fill={METRIC_META[metric].color}
									/>
								);
							});
						})}
					</g>

					<g key={`lines-${animationKey}`}>
						{series.map((s) => (
							<g key={s.metric}>
								{s.metric === "views" && s.area && (
									<path
										className={styles.fade}
										d={s.area}
										fill={`url(#${areaGradientId})`}
										clipPath={`url(#${activeClipId})`}
									/>
								)}
								{hoverX !== null && s.solid && (
									<path
										d={s.solid}
										fill="none"
										stroke="var(--gray-7)"
										strokeWidth={2.25}
										strokeLinecap="round"
										clipPath={`url(#${restClipId})`}
									/>
								)}
								{s.solid && (
									<path
										className={styles.line}
										d={s.solid}
										pathLength={1}
										fill="none"
										stroke={METRIC_META[s.metric].color}
										strokeWidth={s.metric === "views" ? 2.5 : 2}
										strokeLinecap="round"
										strokeLinejoin="round"
										clipPath={`url(#${activeClipId})`}
									/>
								)}
								{s.partial && (
									<path
										className={styles.fade}
										style={timing(1)}
										d={s.partial}
										fill="none"
										stroke={
											hoverX !== null && !isLastBucket
												? "var(--gray-7)"
												: METRIC_META[s.metric].color
										}
										strokeWidth={s.metric === "views" ? 2.5 : 2}
										strokeDasharray="2 5"
										strokeLinecap="round"
									/>
								)}
								{s.points.length === 1 && s.points[0] && (
									<circle
										cx={s.points[0].x}
										cy={s.points[0].y}
										r={4}
										fill={METRIC_META[s.metric].color}
									/>
								)}
							</g>
						))}
					</g>

					{peak && peakPoint && (
						<PeakNote
							key={`peak-${animationKey}-${peak.index}`}
							point={peakPoint}
							label={
								granularity === "hour"
									? "Busiest hour"
									: granularity === "week"
										? "Best week"
										: "Best day"
							}
							value={peak.value}
							metric={peak.metric}
							dimmed={hoverIndex !== null}
							plotLeft={MARGIN.left}
							plotRight={MARGIN.left + plotW}
							plotTop={MARGIN.top}
						/>
					)}

					{hoverX !== null && (
						<line
							x1={hoverX}
							x2={hoverX}
							y1={MARGIN.top - 8}
							y2={baseline}
							stroke="var(--gray-8)"
							strokeDasharray="3 4"
							strokeWidth={1}
						/>
					)}

					{hovered &&
						hoverX !== null &&
						series.map((s) => (
							<g key={`dot-${s.metric}`}>
								<circle
									cx={hoverX}
									cy={yLine(hovered[s.metric])}
									r={8}
									fill={METRIC_META[s.metric].color}
									opacity={0.16}
								/>
								<circle
									cx={hoverX}
									cy={yLine(hovered[s.metric])}
									r={4.5}
									fill="var(--gray-1)"
									stroke={METRIC_META[s.metric].color}
									strokeWidth={2.5}
								/>
							</g>
						))}

					{tickIndices.map((i) => {
						const point = data[i];
						if (!point) return null;
						return (
							<text
								key={`x-${point.bucket}`}
								x={xAt(i)}
								y={baseline + 22}
								textAnchor="middle"
								className="fill-gray-9 text-[11px]"
							>
								{formatBucketTick(point.bucket, granularity, spanDays)}
							</text>
						);
					})}

					<rect
						x={MARGIN.left}
						y={0}
						width={plotW}
						height={HEIGHT}
						fill="transparent"
						onPointerMove={onPointerMove}
						onPointerDown={onPointerMove}
						onPointerLeave={() => setHoverIndex(null)}
					/>
				</svg>
			)}

			{hovered && hoverX !== null && (
				<>
					<div
						className="absolute pointer-events-none -translate-x-1/2 rounded-full border border-gray-5 bg-gray-1 px-2.5 py-0.5 text-[11px] font-medium text-gray-12 shadow-sm whitespace-nowrap"
						style={{
							left: Math.max(
								MARGIN.left + 36,
								Math.min(width - marginRight - 36, hoverX),
							),
							top: baseline + 11,
						}}
					>
						{formatRelative(hovered.bucket, granularity)}
					</div>
					<div
						className="absolute top-2 z-10 pointer-events-none rounded-xl bg-gray-12 p-3.5 text-gray-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35)] transition-[left] duration-75"
						style={{ left: tooltipLeft, width: tooltipWidth }}
					>
						<p className="text-[13px] font-medium leading-tight">
							{formatBucketTitle(
								hovered.bucket,
								granularity,
								hovered.bucketEnd,
							)}
						</p>
						<div className="my-2.5 h-px bg-gray-1/15" />
						<div className="space-y-1.5">
							{metrics.map((metric) => (
								<div
									key={metric}
									className="flex items-center gap-2 text-[13px]"
								>
									<span
										className="size-2.5 rounded-[3px]"
										style={{ background: METRIC_META[metric].color }}
									/>
									<span className="flex-1 text-gray-1/75">
										{METRIC_META[metric].label}
									</span>
									<span className="font-medium tabular-nums">
										{hovered[metric].toLocaleString()}
									</span>
								</div>
							))}
						</div>
						{(isLastBucket || ratio >= 1.5) && (
							<>
								<div className="my-2.5 h-px bg-gray-1/15" />
								<p className="text-[12px] leading-snug text-gray-1/75">
									{isLastBucket
										? `This ${granularity === "hour" ? "hour" : granularity === "week" ? "week" : "day"} is still going, so the count will keep growing.`
										: `${ratio.toFixed(1)}x your ${granularity === "hour" ? "hourly" : granularity === "week" ? "weekly" : "daily"} average`}
								</p>
							</>
						)}
					</div>
				</>
			)}
		</div>
	);
}

function PeakNote({
	point,
	label,
	value,
	metric,
	dimmed,
	plotLeft,
	plotRight,
	plotTop,
}: {
	point: Point;
	label: string;
	value: number;
	metric: Metric;
	dimmed: boolean;
	plotLeft: number;
	plotRight: number;
	plotTop: number;
}) {
	const rx = 19;
	const ry = 15;
	const onRight = point.x < (plotLeft + plotRight) / 2;
	const above = point.y - plotTop > 46;
	const textX = onRight ? point.x + rx + 40 : point.x - rx - 40;
	const textY = above ? point.y - 30 : point.y + 40;
	const arrowStart = {
		x: onRight ? textX - 4 : textX + 4,
		y: above ? textY - 4 : textY - 10,
	};
	const arrowEnd = {
		x: onRight ? point.x + rx + 4 : point.x - rx - 4,
		y: above ? point.y - 7 : point.y + 7,
	};
	const control = {
		x: arrowEnd.x + (onRight ? 4 : -4),
		y: arrowStart.y + (above ? -2 : 2),
	};
	const angle = Math.atan2(arrowEnd.y - control.y, arrowEnd.x - control.x);
	const head = (offset: number) =>
		`${arrowEnd.x - 7 * Math.cos(angle + offset)} ${arrowEnd.y - 7 * Math.sin(angle + offset)}`;
	const unit = metric === "views" ? (value === 1 ? "view" : "views") : "caps";

	return (
		<g
			style={{ opacity: dimmed ? 0.25 : 1, transition: "opacity 0.2s ease" }}
			pointerEvents="none"
		>
			<g className={doodleStyles.boil} filter={`url(#${BOIL_FILTER_LARGE_ID})`}>
				<path
					className={cx(doodleStyles.ink, doodleStyles.draw)}
					style={timing(1.15, 0.7)}
					pathLength={1}
					strokeWidth={2}
					d={sketchLoop(point.x, point.y, rx, ry)}
				/>
				<path
					className={cx(doodleStyles.ink, doodleStyles.draw)}
					style={timing(1.7, 0.35)}
					pathLength={1}
					strokeWidth={1.75}
					d={`M ${arrowStart.x} ${arrowStart.y} Q ${control.x} ${control.y} ${arrowEnd.x} ${arrowEnd.y}`}
				/>
				<path
					className={cx(doodleStyles.ink, doodleStyles.draw)}
					style={timing(2, 0.2)}
					pathLength={1}
					strokeWidth={1.75}
					d={`M ${head(0.5)} L ${arrowEnd.x} ${arrowEnd.y} L ${head(-0.5)}`}
				/>
			</g>
			<text
				className={doodleStyles.appear}
				style={timing(1.9)}
				x={textX}
				y={textY}
				textAnchor={onRight ? "start" : "end"}
			>
				<tspan className="fill-gray-12 text-[12px] font-medium">{label}</tspan>
				<tspan className="fill-gray-10 text-[12px]" dx={6}>
					{value.toLocaleString()} {unit}
				</tspan>
			</text>
		</g>
	);
}
