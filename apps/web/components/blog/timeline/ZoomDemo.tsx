"use client";

import clsx from "clsx";
import {
	type PointerEvent as ReactPointerEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	AnchorLine,
	BranchNode,
	CommentCard,
	LANE_STEM,
	MIN_NODE_GAP,
	NODE_SIZE,
} from "./DemoBits";
import { DemoPanel } from "./DemoPanel";
import { DemoStrip, type DemoWindow, useMeasuredWidth } from "./DemoStrip";
import { layoutDemoNodes } from "./demo-layout";
import { clamp, DEMO_COMMENTS, DEMO_DURATION, formatClock } from "./scene";

/** Floor on the zoom window, in seconds — the product's `MIN_WINDOW_S`. */
const MIN_WINDOW = 10;
const ZOOM_STEP = 1.5;

const FULL: DemoWindow = { start: 0, end: DEMO_DURATION };

/**
 * What happens when three people comment on the same three seconds. At Fit they
 * are a stack; zoom in and they are three separate remarks again.
 */
export function ZoomDemo() {
	const [window, setWindow] = useState<DemoWindow>(FULL);
	const [openId, setOpenId] = useState<string | null>(null);
	const [ref, width] = useMeasuredWidth<HTMLDivElement>();

	const span = window.end - window.start;
	const atFit = span >= DEMO_DURATION - 0.5;

	// Functional: two quick presses of + must compound, not both zoom out of the
	// same starting span.
	const applyZoom = (factor: number, at?: number) => {
		setWindow((current) => {
			const currentSpan = current.end - current.start;
			const focus = at ?? current.start + currentSpan / 2;
			const nextSpan = clamp(currentSpan / factor, MIN_WINDOW, DEMO_DURATION);
			const focusFraction =
				currentSpan > 0 ? (focus - current.start) / currentSpan : 0.5;
			const start = clamp(
				focus - focusFraction * nextSpan,
				0,
				DEMO_DURATION - nextSpan,
			);
			return { start, end: start + nextSpan };
		});
	};

	const nodes = useMemo(
		() => layoutDemoNodes(DEMO_COMMENTS, window, width, MIN_NODE_GAP),
		[window, width],
	);

	const shelfHeight =
		nodes.length > 0
			? Math.max(...nodes.map((node) => LANE_STEM[node.lane])) +
				NODE_SIZE / 2 +
				12
			: 0;

	const open = nodes.find((node) => node.comment.id === openId) ?? null;

	return (
		<DemoPanel
			title="Zoom"
			hint="Three people commented within six seconds, so two of them are stacked. Zoom in until they come apart, then drag the lit region below to move along the recording."
			caption={
				<>
					In Cap you zoom by pinching the strip, or by holding ⌘/Ctrl and
					scrolling on it, and double-click puts it back to Fit. The lit region
					here stands in for that. The zoom window is a slice of the recording,
					not a different recording.
				</>
			}
		>
			<div className="overflow-hidden rounded-xl border border-gray-4 bg-white">
				<div ref={ref}>
					<DemoStrip time={window.start} window={window} film waveform />
				</div>

				<div
					className="relative transition-[height] duration-200"
					style={{ height: shelfHeight }}
				>
					{nodes.length > 0 && <AnchorLine />}
					{nodes.map((node) => (
						<BranchNode
							key={`${node.comment.id}-${node.count}`}
							node={node}
							active={openId === node.comment.id}
							onSelect={() =>
								setOpenId((current) =>
									current === node.comment.id ? null : node.comment.id,
								)
							}
						/>
					))}

					{open && (
						<div
							className="absolute bottom-full z-40 mb-2 -translate-x-1/2"
							style={{ left: `clamp(8.5rem, ${open.percent}%, 100% - 8.5rem)` }}
						>
							<CommentCard comments={open.members} />
						</div>
					)}
				</div>

				<div className="flex items-center justify-between gap-3 border-t border-gray-4 bg-white px-2 py-2 sm:px-3">
					<span className="font-mono text-[12px] tabular-nums text-gray-11">
						{formatClock(window.start)}–{formatClock(window.end)}
						<span className="ml-2 text-gray-9">
							{atFit ? "whole recording" : `${Math.round(span)}s window`}
						</span>
					</span>
					<div className="flex shrink-0 items-center gap-1">
						<ZoomButton
							label="Fit"
							disabled={atFit}
							onClick={() => setWindow(FULL)}
						>
							Fit
						</ZoomButton>
						<ZoomButton
							label="Zoom out"
							disabled={atFit}
							onClick={() => applyZoom(1 / ZOOM_STEP)}
						>
							<svg
								viewBox="0 0 16 16"
								className="size-4 fill-current"
								aria-hidden
							>
								<title>Zoom out</title>
								<rect x="3" y="7.25" width="10" height="1.5" rx="0.75" />
							</svg>
						</ZoomButton>
						<ZoomButton
							label="Zoom in"
							disabled={span <= MIN_WINDOW + 0.5}
							onClick={() => applyZoom(ZOOM_STEP)}
						>
							<svg
								viewBox="0 0 16 16"
								className="size-4 fill-current"
								aria-hidden
							>
								<title>Zoom in</title>
								<rect x="3" y="7.25" width="10" height="1.5" rx="0.75" />
								<rect x="7.25" y="3" width="1.5" height="10" rx="0.75" />
							</svg>
						</ZoomButton>
					</div>
				</div>
			</div>

			<Minimap window={window} onChange={setWindow} />
		</DemoPanel>
	);
}

function ZoomButton({
	children,
	label,
	disabled,
	onClick,
}: {
	children: React.ReactNode;
	label: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			title={label}
			className={clsx(
				"flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
				disabled
					? "cursor-not-allowed text-gray-8"
					: "text-gray-12 hover:bg-gray-3",
			)}
		>
			{children}
		</button>
	);
}

/**
 * The whole recording, with the part currently on the strip lit up. Draggable,
 * standing in for the pinch and ⌘-scroll gestures a blog post has no business
 * hijacking.
 */
function Minimap({
	window,
	onChange,
}: {
	window: DemoWindow;
	onChange: (next: DemoWindow) => void;
}) {
	const drag = useRef<{ x: number; start: number } | null>(null);
	const span = window.end - window.start;
	const full = span >= DEMO_DURATION - 0.5;

	const move = (clientX: number, element: HTMLElement, fromDrag: boolean) => {
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0) return;
		if (fromDrag && drag.current) {
			const deltaT = ((clientX - drag.current.x) / rect.width) * DEMO_DURATION;
			const start = clamp(drag.current.start + deltaT, 0, DEMO_DURATION - span);
			onChange({ start, end: start + span });
			return;
		}
		const centre = ((clientX - rect.left) / rect.width) * DEMO_DURATION;
		const start = clamp(centre - span / 2, 0, DEMO_DURATION - span);
		onChange({ start, end: start + span });
	};

	return (
		<div className="mt-4">
			<div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-10">
				The whole recording
			</div>
			<div
				className="relative h-7 w-full cursor-grab touch-none select-none rounded-lg bg-gray-3"
				onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
					if (full || event.button !== 0) return;
					event.currentTarget.setPointerCapture(event.pointerId);
					const rect = event.currentTarget.getBoundingClientRect();
					const at = ((event.clientX - rect.left) / rect.width) * DEMO_DURATION;
					const inside = at >= window.start && at <= window.end;
					if (inside) drag.current = { x: event.clientX, start: window.start };
					else move(event.clientX, event.currentTarget, false);
				}}
				onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
					if (!drag.current) return;
					move(event.clientX, event.currentTarget, true);
				}}
				onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
					drag.current = null;
					if (event.currentTarget.hasPointerCapture(event.pointerId)) {
						event.currentTarget.releasePointerCapture(event.pointerId);
					}
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
			>
				{DEMO_COMMENTS.map((comment) => (
					<span
						key={comment.id}
						className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-9"
						style={{ left: `${(comment.t / DEMO_DURATION) * 100}%` }}
					/>
				))}
				<div
					className={clsx(
						"absolute inset-y-0 rounded-lg border-2 border-gray-12 bg-gray-12/10",
						full && "opacity-40",
					)}
					style={{
						left: `${(window.start / DEMO_DURATION) * 100}%`,
						width: `${(span / DEMO_DURATION) * 100}%`,
					}}
				/>
			</div>
		</div>
	);
}
