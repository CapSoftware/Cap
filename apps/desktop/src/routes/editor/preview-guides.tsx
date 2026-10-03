import { createSignal, For, onCleanup, Show } from "solid-js";
import { useEditorContext } from "./context";
import {
	type GuideAxis,
	guides,
	isGuideDiscarded,
	RULER_THICKNESS,
	setGuides,
	withGuide,
} from "./ruler-guides";
import { rulerStep } from "./ruler-steps";

const GRID_STORAGE_KEY = "cap.preview.grid";
const RULERS_STORAGE_KEY = "cap.preview.rulers";

const readFlag = (key: string) => {
	try {
		return localStorage.getItem(key) === "on";
	} catch {
		return false;
	}
};

const persistedFlag = (key: string) => {
	const [value, setValue] = createSignal(readFlag(key));
	const toggle = () => {
		const next = !value();
		setValue(next);
		try {
			localStorage.setItem(key, next ? "on" : "off");
		} catch {}
	};
	return [value, toggle] as const;
};

export const [gridVisible, toggleGrid] = persistedFlag(GRID_STORAGE_KEY);
export const [rulersVisible, toggleRulers] = persistedFlag(RULERS_STORAGE_KEY);

type Size = { width: number; height: number };

const FINE_DIVISIONS = 12;

export function PreviewGridOverlay(props: { size: Size }) {
	const fine = () =>
		Array.from(
			{ length: FINE_DIVISIONS - 1 },
			(_, i) => (i + 1) / FINE_DIVISIONS,
		);
	return (
		<Show when={gridVisible()}>
			<svg
				class="absolute inset-0 pointer-events-none"
				width={props.size.width}
				height={props.size.height}
				aria-hidden="true"
			>
				<g stroke="rgba(255,255,255,0.14)" stroke-width="1">
					<For each={fine()}>
						{(f) => (
							<>
								<line
									x1={f * props.size.width}
									x2={f * props.size.width}
									y1={0}
									y2={props.size.height}
								/>
								<line
									y1={f * props.size.height}
									y2={f * props.size.height}
									x1={0}
									x2={props.size.width}
								/>
							</>
						)}
					</For>
				</g>
				<For each={[1 / 3, 2 / 3]}>
					{(f) => (
						<g stroke-width="1">
							<line
								x1={f * props.size.width}
								x2={f * props.size.width}
								y1={0}
								y2={props.size.height}
								stroke="rgba(0,0,0,0.35)"
								transform="translate(1 0)"
							/>
							<line
								x1={f * props.size.width}
								x2={f * props.size.width}
								y1={0}
								y2={props.size.height}
								stroke="rgba(255,255,255,0.7)"
							/>
							<line
								y1={f * props.size.height}
								y2={f * props.size.height}
								x1={0}
								x2={props.size.width}
								stroke="rgba(0,0,0,0.35)"
								transform="translate(0 1)"
							/>
							<line
								y1={f * props.size.height}
								y2={f * props.size.height}
								x1={0}
								x2={props.size.width}
								stroke="rgba(255,255,255,0.7)"
							/>
						</g>
					)}
				</For>
				<g
					stroke="rgba(255,255,255,0.45)"
					stroke-width="1"
					stroke-dasharray="4 4"
				>
					<line
						x1={props.size.width / 2}
						x2={props.size.width / 2}
						y1={0}
						y2={props.size.height}
					/>
					<line
						y1={props.size.height / 2}
						y2={props.size.height / 2}
						x1={0}
						x2={props.size.width}
					/>
				</g>
			</svg>
		</Show>
	);
}

function rulerTicks(outputLength: number, cssLength: number) {
	const scale = cssLength / Math.max(outputLength, 1);
	const step = rulerStep(scale);
	const minor = step / 5;
	const ticks: Array<{ at: number; value: number; major: boolean }> = [];
	for (let value = 0; value <= outputLength + 0.5; value += minor) {
		const rounded = Math.round(value);
		ticks.push({
			at: rounded * scale,
			value: rounded,
			major: Math.round(value / minor) % 5 === 0,
		});
	}
	return ticks;
}

type GuideDrag = { axis: GuideAxis; index: number | null; position: number };

const GUIDE_COLOR = "#22d3ee";

export function PreviewRulersOverlay(props: { size: Size }) {
	const { latestFrameLayout } = useEditorContext();
	const outputWidth = () => latestFrameLayout()?.output_width ?? 1920;
	const outputHeight = () => latestFrameLayout()?.output_height ?? 1080;
	const [drag, setDrag] = createSignal<GuideDrag | null>(null);
	let root: HTMLDivElement | undefined;
	let stopDrag: (() => void) | undefined;
	onCleanup(() => stopDrag?.());

	const startDrag = (
		axis: GuideAxis,
		index: number | null,
		event: MouseEvent,
	) => {
		if (event.button !== 0 || !root) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = root.getBoundingClientRect();
		const length = axis === "v" ? rect.width : rect.height;
		const positionFor = (e: MouseEvent) =>
			axis === "v"
				? (e.clientX - rect.left) / Math.max(rect.width, 1)
				: (e.clientY - rect.top) / Math.max(rect.height, 1);
		setDrag({ axis, index, position: positionFor(event) });
		const move = (e: MouseEvent) =>
			setDrag((current) => current && { ...current, position: positionFor(e) });
		const up = (e: MouseEvent) => {
			stopDrag?.();
			const position = positionFor(e);
			setDrag(null);
			setGuides(
				withGuide(
					guides(),
					axis,
					index,
					isGuideDiscarded(position, length) ? null : position,
				),
			);
		};
		stopDrag = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			stopDrag = undefined;
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	};

	// The rulers sit above the canvas element boxes, so a press on an element
	// or handle that reaches under a ruler is handed to it instead of
	// starting a guide.
	const startRulerDrag = (axis: GuideAxis, event: MouseEvent) => {
		const element = document
			.elementsFromPoint(event.clientX, event.clientY)
			.find((el) => el.closest("[data-canvas-element]"));
		if (element) {
			element.dispatchEvent(new MouseEvent("mousedown", event));
			return;
		}
		startDrag(axis, null, event);
	};

	const shownGuides = (axis: GuideAxis) =>
		guides()
			[axis].map((position, index) => ({ position, index }))
			.filter(({ index }) => {
				const current = drag();
				return !(current && current.axis === axis && current.index === index);
			});

	return (
		<Show when={rulersVisible()}>
			<div ref={root} class="absolute inset-0 pointer-events-none">
				<For each={shownGuides("v")}>
					{(guide) => (
						<div
							class="absolute top-0 bottom-0 w-[7px] -ml-[3px] cursor-col-resize pointer-events-auto flex justify-center"
							style={{ left: `${guide.position * props.size.width}px` }}
							onMouseDown={(e) => startDrag("v", guide.index, e)}
						>
							<div class="w-px h-full" style={{ background: GUIDE_COLOR }} />
						</div>
					)}
				</For>
				<For each={shownGuides("h")}>
					{(guide) => (
						<div
							class="absolute left-0 right-0 h-[7px] -mt-[3px] cursor-row-resize pointer-events-auto flex items-center"
							style={{ top: `${guide.position * props.size.height}px` }}
							onMouseDown={(e) => startDrag("h", guide.index, e)}
						>
							<div class="h-px w-full" style={{ background: GUIDE_COLOR }} />
						</div>
					)}
				</For>
				<Show when={drag()}>
					{(current) => {
						const discarded = () =>
							isGuideDiscarded(
								current().position,
								current().axis === "v" ? props.size.width : props.size.height,
							);
						const pixels = () =>
							Math.round(
								current().position *
									(current().axis === "v" ? outputWidth() : outputHeight()),
							);
						return (
							<div
								class="absolute pointer-events-none"
								style={
									current().axis === "v"
										? {
												top: "0",
												bottom: "0",
												left: `${current().position * props.size.width}px`,
												width: "1px",
												background: GUIDE_COLOR,
												opacity: discarded() ? 0.35 : 1,
											}
										: {
												left: "0",
												right: "0",
												top: `${current().position * props.size.height}px`,
												height: "1px",
												background: GUIDE_COLOR,
												opacity: discarded() ? 0.35 : 1,
											}
								}
							>
								<span class="absolute top-6 left-2 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums text-black whitespace-nowrap bg-cyan-300">
									{discarded() ? "Remove" : `${pixels()} px`}
								</span>
							</div>
						);
					}}
				</Show>
			</div>
			<svg
				class="absolute inset-0 pointer-events-none"
				width={props.size.width}
				height={props.size.height}
				aria-hidden="true"
				font-size="9"
				font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
			>
				<rect
					x={0}
					y={0}
					width={props.size.width}
					height={RULER_THICKNESS}
					fill="rgba(20,20,22,0.72)"
					style={{ "pointer-events": "auto", cursor: "row-resize" }}
					onMouseDown={(e) => startRulerDrag("h", e)}
				/>
				<rect
					x={0}
					y={0}
					width={RULER_THICKNESS}
					height={props.size.height}
					fill="rgba(20,20,22,0.72)"
					style={{ "pointer-events": "auto", cursor: "col-resize" }}
					onMouseDown={(e) => startRulerDrag("v", e)}
				/>
				<g stroke="rgba(255,255,255,0.7)" stroke-width="1">
					<For each={rulerTicks(outputWidth(), props.size.width)}>
						{(tick) => (
							<line
								x1={tick.at + 0.5}
								x2={tick.at + 0.5}
								y1={tick.major ? 0 : RULER_THICKNESS * 0.6}
								y2={RULER_THICKNESS}
							/>
						)}
					</For>
					<For each={rulerTicks(outputHeight(), props.size.height)}>
						{(tick) => (
							<line
								y1={tick.at + 0.5}
								y2={tick.at + 0.5}
								x1={tick.major ? 0 : RULER_THICKNESS * 0.6}
								x2={RULER_THICKNESS}
							/>
						)}
					</For>
				</g>
				<g fill="rgba(255,255,255,0.85)">
					<For
						each={rulerTicks(outputWidth(), props.size.width).filter(
							(tick) => tick.major && tick.at > RULER_THICKNESS,
						)}
					>
						{(tick) => (
							<text x={tick.at + 3} y={9}>
								{tick.value}
							</text>
						)}
					</For>
					<For
						each={rulerTicks(outputHeight(), props.size.height).filter(
							(tick) => tick.major && tick.at > RULER_THICKNESS,
						)}
					>
						{(tick) => (
							<text
								x={9}
								y={tick.at + 3}
								transform={`rotate(-90 9 ${tick.at + 3})`}
								text-anchor="end"
							>
								{tick.value}
							</text>
						)}
					</For>
				</g>
			</svg>
		</Show>
	);
}
