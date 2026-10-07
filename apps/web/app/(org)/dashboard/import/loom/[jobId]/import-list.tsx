"use client";

import clsx from "clsx";
import Link from "next/link";
import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type LoomImportDisplayStatus,
	type LoomImportItemView,
	loomImportStageLabel,
} from "@/lib/loom-import/status";

export const ROW_HEIGHT = 64;
const OVERSCAN = 8;
const SCROLL_SETTLE_MS = 140;
const loadedThumbs = new Set<string>();

const dateFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

export function formatDuration(seconds: number | null | undefined) {
	if (!seconds || seconds <= 0) return null;
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
		: `${minutes}:${String(secs).padStart(2, "0")}`;
}

function shortLoomUrl(url: string) {
	return url.replace(/^https?:\/\/(www\.)?/, "");
}

export function useVirtualWindow(count: number, viewport: number) {
	const ref = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [scrolling, setScrolling] = useState(false);
	const frame = useRef<number | null>(null);
	const settle = useRef<number | undefined>(undefined);

	const onScroll = useCallback(() => {
		window.clearTimeout(settle.current);
		settle.current = window.setTimeout(
			() => setScrolling(false),
			SCROLL_SETTLE_MS,
		);
		if (frame.current !== null) return;
		frame.current = window.requestAnimationFrame(() => {
			frame.current = null;
			setScrolling(true);
			setScrollTop(ref.current?.scrollTop ?? 0);
		});
	}, []);

	useEffect(
		() => () => {
			if (frame.current !== null) window.cancelAnimationFrame(frame.current);
			window.clearTimeout(settle.current);
		},
		[],
	);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const max = Math.max(0, count * ROW_HEIGHT - viewport);
		if (element.scrollTop > max) {
			element.scrollTop = max;
			setScrollTop(max);
		}
	}, [count, viewport]);

	const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const end = Math.min(
		count,
		Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN,
	);
	return { ref, onScroll, start, end, scrolling };
}

const STATUS_TONE: Record<LoomImportDisplayStatus, string> = {
	checking: "text-gray-10",
	ready: "text-gray-11",
	queued: "text-gray-10",
	importing: "text-[var(--li-accent)]",
	imported: "text-[#218358] dark:text-[#3dd68c]",
	failed: "text-red-11",
	skipped: "text-gray-10",
	cancelled: "text-gray-9",
};

const STATUS_LABEL: Record<LoomImportDisplayStatus, string> = {
	checking: "Checking",
	ready: "Ready",
	queued: "Queued",
	importing: "Importing",
	imported: "In Cap",
	failed: "Failed",
	skipped: "Skipped",
	cancelled: "Cancelled",
};

const Tick = () => (
	<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
		<path
			d="M 3.5 8.5 L 6.5 11.5 L 12.5 4.5"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const StatusCell = ({ item }: { item: LoomImportItemView }) => {
	const tone = STATUS_TONE[item.status];
	if (item.status === "importing") {
		const progress = item.progress ?? 0;
		return (
			<div className="flex w-full flex-col items-end gap-1.5">
				<span className={clsx("text-xs", tone)}>
					{loomImportStageLabel(item.stage)}
				</span>
				<div className="h-1 w-full max-w-[120px] overflow-hidden rounded-full bg-gray-4">
					<div
						className={clsx(
							"li-bar h-full rounded-full bg-blue-9",
							item.stage === "waiting" && "li-pulse",
						)}
						style={{ width: `${Math.max(4, progress)}%` }}
					/>
				</div>
			</div>
		);
	}

	if (item.status === "imported" && item.videoId) {
		return (
			<Link
				href={`/s/${item.videoId}`}
				className={clsx(
					"inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors hover:bg-gray-3",
					tone,
				)}
			>
				<Tick />
				{STATUS_LABEL.imported}
			</Link>
		);
	}

	if (item.status === "skipped" && item.videoId) {
		return (
			<Link
				href={`/s/${item.videoId}`}
				title={item.error}
				className="inline-flex flex-col items-end text-right text-xs text-gray-10 hover:text-gray-12"
			>
				<span>Already in Cap</span>
				<span className="underline decoration-gray-6 underline-offset-2">
					Open it
				</span>
			</Link>
		);
	}

	return (
		<div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
			<span className={clsx("inline-flex items-center gap-1.5 text-xs", tone)}>
				{item.status === "checking" && (
					<span className="li-pulse size-1.5 rounded-full bg-gray-9" />
				)}
				{STATUS_LABEL[item.status]}
			</span>
			{item.error && (
				<span
					className="line-clamp-2 max-w-[220px] text-[11px] leading-snug text-gray-10"
					title={item.error}
				>
					{item.error}
				</span>
			)}
		</div>
	);
};

const Thumb = ({
	src,
	deferred,
}: {
	src: string | null;
	deferred: boolean;
}) => (
	<div className="relative h-10 w-[71px] shrink-0 overflow-hidden rounded-md bg-gray-3">
		{src && (!deferred || loadedThumbs.has(src)) && (
			<img
				src={src}
				alt=""
				loading="lazy"
				decoding="async"
				draggable={false}
				className="size-full object-cover"
				referrerPolicy="no-referrer"
				onLoad={() => loadedThumbs.add(src)}
			/>
		)}
	</div>
);

export const ImportRow = memo(function ImportRow({
	item,
	showOwner,
	scrolling,
}: {
	item: LoomImportItemView;
	showOwner: boolean;
	scrolling: boolean;
}) {
	const meta = [
		item.recordedAt
			? `Recorded ${dateFormat.format(new Date(item.recordedAt))}`
			: null,
		formatDuration(item.duration),
		showOwner ? item.email : null,
		item.space,
	].filter(Boolean);
	return (
		<div className="li-row flex h-full items-center gap-3 border-b border-gray-3 px-4">
			<Thumb src={item.thumb} deferred={scrolling} />
			<div className="min-w-0 flex-1">
				<p
					className={clsx(
						"truncate text-sm",
						item.title ? "text-gray-12" : "font-mono text-[13px] text-gray-11",
					)}
				>
					{item.title ?? shortLoomUrl(item.url)}
				</p>
				<p className="truncate text-xs text-gray-10" suppressHydrationWarning>
					<span className="tabular-nums">Row {item.row}</span>
					{meta.length > 0 && ` · ${meta.join(" · ")}`}
				</p>
			</div>
			<div className="flex w-[136px] shrink-0 justify-end sm:w-[180px]">
				<StatusCell item={item} />
			</div>
		</div>
	);
});

export const VirtualImportList = ({
	items,
	viewport,
	showOwner,
	empty,
}: {
	items: LoomImportItemView[];
	viewport: number;
	showOwner: boolean;
	empty: ReactNode;
}) => {
	const { ref, onScroll, start, end, scrolling } = useVirtualWindow(
		items.length,
		viewport,
	);
	const height = Math.min(viewport, Math.max(items.length, 1) * ROW_HEIGHT);

	if (items.length === 0) {
		return (
			<div className="flex items-center justify-center px-6 py-14 text-sm text-gray-10">
				{empty}
			</div>
		);
	}

	return (
		<div
			ref={ref}
			onScroll={onScroll}
			className="custom-scroll relative overflow-y-auto overscroll-contain"
			style={{ height }}
			data-testid="loom-import-list"
		>
			<ul
				aria-label="Videos in this import"
				style={{ height: items.length * ROW_HEIGHT, position: "relative" }}
			>
				{items.slice(start, end).map((item, index) => (
					<li
						key={item.id}
						aria-setsize={items.length}
						aria-posinset={start + index + 1}
						className="absolute inset-x-0 top-0"
						style={{
							height: ROW_HEIGHT,
							transform: `translateY(${(start + index) * ROW_HEIGHT}px)`,
						}}
					>
						<ImportRow
							item={item}
							showOwner={showOwner}
							scrolling={scrolling}
						/>
					</li>
				))}
			</ul>
		</div>
	);
};
