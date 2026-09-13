import { Popover } from "@kobalte/core/popover";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	batch,
	type ComponentProps,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	Index,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { produce } from "solid-js/store";
import type { TimelineSegment } from "~/utils/tauri";
import IconLucideArrowLeftToLine from "~icons/lucide/arrow-left-to-line";
import IconLucideArrowRightToLine from "~icons/lucide/arrow-right-to-line";
import IconLucideMousePointerBan from "~icons/lucide/mouse-pointer-ban";
import IconLucideScissors from "~icons/lucide/scissors";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideVolumeX from "~icons/lucide/volume-x";
import { clipAudioMuted, clipVolume } from "../clip-audio";
import {
	type ClipMergeDirection,
	clipMergeBlocker,
	clipMergeBlockerHint,
} from "../clip-merge";
import {
	clampTransitionDuration,
	clipTimelineDuration,
	clipTimelineOffsets,
	clipTransitionMap,
	DEFAULT_CLIP_TRANSITION_DURATION,
	getClipTransition,
	MIN_CLIP_TRANSITION_DURATION,
	maxTransitionDuration,
} from "../clip-transitions";
import { useEditorContext } from "../context";
import { TextInput } from "../TextInput";
import { effectiveToOutput, holdWindows } from "../timeline-holds";
import { Slider } from "../ui";
import { useSegmentContext, useTimelineContext } from "./context";
import { getSectionMarker } from "./sectionMarker";
import { SPLIT_SNAP_PX, snapSplitTime } from "./split-snapping";
import {
	SegmentContent,
	SegmentHandle,
	SegmentLabel,
	SegmentRoot,
	TrackRoot,
	useSegmentTranslateX,
	useSegmentWidth,
	useSetPreviewTime,
} from "./Track";

const CANVAS_HEIGHT = 52;
const WAVEFORM_MIN_DB = -60;
const WAVEFORM_SAMPLE_STEP = 0.1;
const WAVEFORM_CONTROL_STEP = 0.05;
const WAVEFORM_PADDING_SECONDS = 0.3;

const WAVEFORM_MUTE_DB = -30;
const MIN_CLIP_SEGMENT_PIXEL_WIDTH = 100;

function gainToScale(gain?: number) {
	if (!Number.isFinite(gain)) return 1;
	const value = gain as number;
	if (value <= WAVEFORM_MUTE_DB) return 0;
	return Math.max(0, (value - WAVEFORM_MUTE_DB) / -WAVEFORM_MUTE_DB);
}

const MAX_WAVEFORM_SAMPLES = 6000;

// `range` is in output (timeline) time; `sourceTimeAt` maps an output time to
// recording time, or null while a fullscreen-text hold has the clock paused —
// the mixer renders silence there, so the waveform drops to the baseline.
function createWaveformPath(
	range: { start: number; end: number },
	waveform: number[] | undefined,
	targetSamples: number,
	sourceTimeAt: (outputTime: number) => number | null,
) {
	if (typeof Path2D === "undefined") return;
	if (!waveform || waveform.length === 0) return;

	const duration = Math.max(range.end - range.start, WAVEFORM_SAMPLE_STEP);
	if (!Number.isFinite(duration) || duration <= 0) return;

	const nativeSamples = Math.ceil(duration / WAVEFORM_SAMPLE_STEP) + 1;
	const numSamples = Math.min(
		Math.max(targetSamples, 50),
		MAX_WAVEFORM_SAMPLES,
		nativeSamples,
	);

	const timeStep = duration / numSamples;

	const path = new Path2D();
	path.moveTo(0, 1);

	const amplitudeAt = (outputTime: number) => {
		const time = sourceTimeAt(outputTime);
		if (time === null) return 0;
		const index = Math.floor(time * 10);
		const sample = waveform[index];
		const db =
			typeof sample === "number" && Number.isFinite(sample)
				? sample
				: WAVEFORM_MIN_DB;
		const clamped = Math.max(db, WAVEFORM_MIN_DB);
		const amplitude = 1 + clamped / -WAVEFORM_MIN_DB;
		return Math.min(Math.max(amplitude, 0), 1);
	};

	const controlStep = Math.min(WAVEFORM_CONTROL_STEP / duration, 0.25);

	for (let i = 0; i <= numSamples; i++) {
		const time = range.start + i * timeStep;
		const normalizedX = (time - range.start) / duration;
		const prevTime = time - timeStep;
		const prevX = Math.max(0, (prevTime - range.start) / duration);
		const y = 1 - amplitudeAt(time);
		const prevY = 1 - amplitudeAt(prevTime);
		const cpX1 = prevX + controlStep / 2;
		const cpX2 = normalizedX - controlStep / 2;
		path.bezierCurveTo(cpX1, prevY, cpX2, y, normalizedX, y);
	}

	const closingX =
		(range.end + WAVEFORM_PADDING_SECONDS - range.start) / duration;
	path.lineTo(closingX, 1);
	path.closePath();

	return path;
}

function formatTime(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	} else if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	} else {
		return `${seconds}s`;
	}
}

const MAX_CANVAS_WIDTH = 2000;
const SAMPLES_PER_PIXEL = 2;

function WaveformCanvas(props: {
	systemWaveform?: number[];
	micWaveform?: number[];
	segment: Pick<TimelineSegment, "start" | "end" | "volume">;
	segmentOffset: number;
	holds: ReadonlyArray<[number, number]>;
}) {
	const { project, editorState } = useEditorContext();
	const { width } = useSegmentContext();
	const { timelineBounds } = useTimelineContext();

	let canvas: HTMLCanvasElement | undefined;
	let rafId: number | null = null;
	let lastRenderKey = "";
	let pathKey = "";
	let micPath: Path2D | undefined;
	let systemPath: Path2D | undefined;
	let cachedMicWaveform: number[] | undefined;
	let cachedSystemWaveform: number[] | undefined;

	const renderCanvas = () => {
		rafId = null;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		// Hold windows relative to the clip's box; the box is stretched across
		// them, so the canvas spans output time, not source time.
		const holds = props.holds.map(([start, end]): [number, number] => [
			start - props.segmentOffset,
			end - props.segmentOffset,
		]);
		const heldDuration = holds.reduce(
			(sum, [start, end]) => sum + end - start,
			0,
		);
		const outputDuration =
			props.segment.end - props.segment.start + heldDuration;
		const fullSegmentWidth = width();

		if (fullSegmentWidth < 1 || outputDuration <= 0) {
			return;
		}

		const sourceTimeAt = (outputTime: number): number | null => {
			let held = 0;
			for (const [start, end] of holds) {
				if (outputTime >= end) held += end - start;
				else if (outputTime > start) return null;
				else break;
			}
			return props.segment.start + outputTime - held;
		};

		const useVirtualization = fullSegmentWidth > MAX_CANVAS_WIDTH;

		let canvasWidth: number;
		let leftOffsetPx: number;
		let renderWidth: number;
		let renderRange: { start: number; end: number };

		if (useVirtualization) {
			const viewportWidth = timelineBounds.width ?? 800;
			const transform = editorState.timeline.transform;
			const viewStart = transform.position;
			const viewEnd = viewStart + transform.zoom;

			const segStart = props.segmentOffset;
			const segEnd = segStart + outputDuration;

			const visibleStart = Math.max(viewStart, segStart);
			const visibleEnd = Math.min(viewEnd, segEnd);

			if (visibleEnd <= visibleStart) {
				canvas.width = 1;
				canvas.style.left = "0px";
				canvas.style.width = "1px";
				lastRenderKey = "";
				return;
			}

			const visibleStartInSegment = visibleStart - segStart;
			const visibleEndInSegment = visibleEnd - segStart;

			const pxPerSec = fullSegmentWidth / outputDuration;
			const visibleWidthPx = Math.min(
				(visibleEndInSegment - visibleStartInSegment) * pxPerSec,
				viewportWidth + 200,
			);

			canvasWidth = Math.min(
				Math.max(Math.ceil(visibleWidthPx), 1),
				MAX_CANVAS_WIDTH,
			);
			leftOffsetPx = visibleStartInSegment * pxPerSec;
			renderWidth = visibleWidthPx;
			renderRange = {
				start: visibleStartInSegment,
				end: visibleEndInSegment,
			};
		} else {
			canvasWidth = Math.max(Math.ceil(fullSegmentWidth), 1);
			leftOffsetPx = 0;
			renderWidth = fullSegmentWidth;
			renderRange = { start: 0, end: outputDuration };
		}

		const volume = clipVolume(props.segment);
		const micScale = gainToScale(project.audio.micVolumeDb) * volume;
		const systemScale = gainToScale(project.audio.systemVolumeDb) * volume;

		const holdsKey = holds.map(([start, end]) => `${start}:${end}`).join(",");
		const geometryKey = `${canvasWidth}-${props.segment.start}-${renderRange.start}-${renderRange.end}-${holdsKey}`;
		const renderKey = `${geometryKey}-${leftOffsetPx}-${renderWidth}-${micScale}-${systemScale}`;
		const micWaveform = props.micWaveform;
		const systemWaveform = props.systemWaveform;
		const micChanged = cachedMicWaveform !== micWaveform;
		const systemChanged = cachedSystemWaveform !== systemWaveform;
		if (renderKey === lastRenderKey && !micChanged && !systemChanged) {
			return;
		}
		lastRenderKey = renderKey;

		if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
		const left = `${leftOffsetPx}px`;
		const cssWidth = `${renderWidth}px`;
		if (canvas.style.left !== left) canvas.style.left = left;
		if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;

		const canvasHeight = canvas.height;
		ctx.clearRect(0, 0, canvasWidth, canvasHeight);

		const numSamples = Math.min(
			Math.ceil(canvasWidth * SAMPLES_PER_PIXEL),
			MAX_WAVEFORM_SAMPLES,
		);

		if (pathKey !== geometryKey || micChanged) {
			micPath = createWaveformPath(
				renderRange,
				micWaveform,
				numSamples,
				sourceTimeAt,
			);
			cachedMicWaveform = micWaveform;
		}
		if (pathKey !== geometryKey || systemChanged) {
			systemPath = createWaveformPath(
				renderRange,
				systemWaveform,
				numSamples,
				sourceTimeAt,
			);
			cachedSystemWaveform = systemWaveform;
		}
		pathKey = geometryKey;

		const drawWaveform = (path: Path2D | undefined, scale: number) => {
			if (!path || scale <= 0) return;
			ctx.save();
			ctx.translate(0, canvasHeight * (1 - scale));
			ctx.scale(canvasWidth, canvasHeight * scale);
			ctx.fill(path);
			ctx.restore();
		};

		ctx.fillStyle = getComputedStyle(canvas).color;
		ctx.globalAlpha = 0.55;
		drawWaveform(micPath, micScale);
		drawWaveform(systemPath, systemScale);
		ctx.globalAlpha = 1;
	};

	createEffect(() => {
		width();
		timelineBounds.width;
		editorState.timeline.transform.position;
		editorState.timeline.transform.zoom;
		props.segment.start;
		props.segment.end;
		props.segment.volume;
		props.segmentOffset;
		props.holds;
		props.micWaveform;
		props.systemWaveform;
		project.audio.micVolumeDb;
		project.audio.systemVolumeDb;

		if (rafId !== null) {
			cancelAnimationFrame(rafId);
		}
		rafId = requestAnimationFrame(renderCanvas);
	});

	onMount(() => {
		const timeout = setTimeout(() => {
			lastRenderKey = "";
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			rafId = requestAnimationFrame(renderCanvas);
		}, 300);
		onCleanup(() => clearTimeout(timeout));
	});

	onCleanup(() => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
		}
	});

	return (
		<canvas
			ref={(el) => {
				canvas = el;
			}}
			class="absolute bottom-0 h-[18px] pointer-events-none"
			style={{ left: "0px", color: "var(--track-clip)" }}
			height={CANVAS_HEIGHT}
		/>
	);
}

const CLIP_SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8] as const;

type ClipMenuAnchor = { x: number; y: number };

function ClipMenuSection(props: { name: string; children: JSX.Element }) {
	return (
		<div class="flex flex-col gap-1">
			<span class="px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ed-text-3">
				{props.name}
			</span>
			{props.children}
		</div>
	);
}

function ClipMenuChips<T extends string | number>(props: {
	options: ReadonlyArray<readonly [T, string]>;
	value: T;
	onChange: (value: T) => void;
	label: string;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={props.label}
			class="flex items-center gap-0.5 rounded-lg bg-ed-ctl p-0.5"
		>
			<For each={props.options}>
				{([value, label]) => (
					<button
						type="button"
						role="radio"
						aria-checked={props.value === value}
						class={cx(
							"flex-1 rounded-md px-1.5 py-1 text-[11.5px] whitespace-nowrap tabular-nums transition-colors outline-hidden focus-visible:ring-1 focus-visible:ring-ed-accent",
							props.value === value
								? "bg-ed-ctl-active text-ed-text-1"
								: "text-ed-text-2 hover:text-ed-text-1",
						)}
						onClick={() => props.onChange(value)}
					>
						{label}
					</button>
				)}
			</For>
		</div>
	);
}

function ClipMenuToggleRow(props: {
	icon: JSX.Element;
	label: string;
	description: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.checked}
			class="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors outline-hidden hover:bg-ed-ctl-hover focus-visible:bg-ed-ctl-hover"
			onClick={() => props.onChange(!props.checked)}
		>
			<span
				class={cx(
					"flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
					props.checked ? "text-ed-accent" : "text-ed-text-2",
				)}
			>
				{props.icon}
			</span>
			<span class="flex min-w-0 flex-1 flex-col leading-tight">
				<span class="truncate text-[12.5px] text-ed-text-1">{props.label}</span>
				<span class="truncate text-[10.5px] text-ed-text-3">
					{props.description}
				</span>
			</span>
			<span
				aria-hidden
				class={cx(
					"cap-toggle relative h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
					props.checked ? "bg-ed-accent" : "bg-ed-ctl-active",
				)}
			>
				<span
					class={cx(
						"cap-toggle-thumb block size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22)] transition-transform",
						props.checked && "translate-x-full",
					)}
				/>
			</span>
		</button>
	);
}

function ClipMenuRow(props: {
	icon: JSX.Element;
	label: string;
	hint?: string;
	kbd?: string;
	disabled?: boolean;
	danger?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			title={props.disabled ? props.hint : undefined}
			class={cx(
				"flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12.5px] transition-colors outline-hidden disabled:cursor-default disabled:text-ed-text-3",
				props.danger
					? "text-red-400 enabled:hover:bg-red-500/10 focus-visible:bg-red-500/10"
					: "text-ed-text-1 enabled:hover:bg-ed-ctl-hover focus-visible:bg-ed-ctl-hover",
			)}
			onClick={() => props.onClick()}
		>
			<span
				class={cx(
					"flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
					!props.danger && !props.disabled && "text-ed-text-2",
				)}
			>
				{props.icon}
			</span>
			<span class="min-w-0 flex-1 truncate">{props.label}</span>
			<Show when={props.disabled && props.hint}>
				<span class="shrink-0 text-[10.5px] text-ed-text-3">{props.hint}</span>
			</Show>
			<Show when={!props.disabled && props.kbd}>
				<kbd class="shrink-0 rounded-[4px] bg-ed-ctl px-1 font-sans text-[10px] text-ed-text-3">
					{props.kbd}
				</kbd>
			</Show>
		</button>
	);
}

function ClipSettingsControl(props: {
	index: number;
	segment: TimelineSegment;
	label: string;
	defaultLabel: string;
	box: { start: number; end: number };
	open: boolean;
	anchor: ClipMenuAnchor | null;
	onOpenChange: (open: boolean) => void;
	triggerClass?: string;
}) {
	const { project, projectActions, editorState } = useEditorContext();
	const [renaming, setRenaming] = createSignal(false);
	const [draftName, setDraftName] = createSignal("");

	const segments = () => project.timeline?.segments ?? [];
	const muted = () => clipAudioMuted(props.segment);
	const silent = () => muted() || clipVolume(props.segment) === 0;
	const cursorHidden = () => props.segment.hideCursor === true;
	const normalSpeed = () => props.segment.timescale === 1;

	const playheadTime = () =>
		editorState.previewTime ?? editorState.playbackTime;
	const canSplitAtPlayhead = () => {
		const time = playheadTime();
		return time > props.box.start && time < props.box.end;
	};
	const mergeBlocker = (direction: ClipMergeDirection) =>
		clipMergeBlocker(segments(), props.index, direction);
	const mergeHint = (direction: ClipMergeDirection) => {
		const blocker = mergeBlocker(direction);
		return blocker ? clipMergeBlockerHint(blocker) : undefined;
	};
	const canDelete = () => segments().length > 1;

	const close = () => props.onOpenChange(false);

	createEffect(() => {
		if (!props.open) setRenaming(false);
	});

	const startRename = () => {
		setDraftName(props.segment.name?.trim() ?? "");
		setRenaming(true);
	};
	const commitRename = () => {
		if (!renaming()) return;
		projectActions.setClipSegmentName(props.index, draftName());
		setRenaming(false);
	};

	return (
		<Popover
			placement={props.anchor ? "bottom-start" : "top"}
			gutter={props.anchor ? 4 : 8}
			open={props.open}
			onOpenChange={props.onOpenChange}
			getAnchorRect={() =>
				props.anchor
					? { x: props.anchor.x, y: props.anchor.y, width: 0, height: 0 }
					: undefined
			}
		>
			<Popover.Trigger
				class={cx(
					"pointer-events-auto flex items-center gap-0.5 rounded-full bg-ed-ctl-active px-1.5 py-0.5 text-[10px] font-medium text-ed-text-2 transition-colors hover:bg-ed-ctl-hover hover:text-ed-text-1",
					props.triggerClass,
				)}
				aria-label="Clip settings"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<IconLucideSettings class="size-3" />
				<Show
					when={silent()}
					fallback={<span>{props.segment.timescale}x</span>}
				>
					<IconLucideVolumeX class="size-3" />
				</Show>
				<Show when={cursorHidden()}>
					<IconLucideMousePointerBan class="size-3" />
				</Show>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					onMouseDown={(event) => event.stopPropagation()}
					class="z-50 flex w-[300px] max-w-[calc(100vw-16px)] flex-col gap-2 rounded-xl bg-ed-card p-1.5 text-ed-text-1 shadow-ed-pop outline-hidden animate-in fade-in zoom-in-95 duration-100"
				>
					<div class="flex items-center gap-2 px-2 pt-1">
						<span class="min-w-0 flex-1 truncate text-[12px] font-medium text-ed-text-1">
							{props.label}
						</span>
						<span class="shrink-0 text-[11px] tabular-nums text-ed-text-3">
							{formatTime(props.segment.end - props.segment.start)}
							<Show when={!normalSpeed()}>
								{" · "}
								{props.segment.timescale}x
							</Show>
						</span>
					</div>

					<ClipMenuSection name="Speed">
						<ClipMenuChips
							label="Clip speed"
							options={CLIP_SPEEDS.map((mult) => [mult, `${mult}x`] as const)}
							value={props.segment.timescale}
							onChange={(mult) =>
								projectActions.setClipSegmentTimescale(props.index, mult)
							}
						/>
					</ClipMenuSection>

					<ClipMenuSection name="Audio">
						<div class="flex h-7 items-center gap-2 px-2 text-[11.5px]">
							<span class="w-12 shrink-0 text-ed-text-2">Volume</span>
							<Slider
								class="min-w-0 flex-1"
								aria-label="Clip volume"
								value={[Math.round(clipVolume(props.segment) * 100)]}
								minValue={0}
								maxValue={200}
								step={1}
								disabled={muted()}
								onChange={([value]) =>
									projectActions.setClipSegmentVolume(props.index, value / 100)
								}
								formatTooltip={(value) => `${value}%`}
							/>
							<span class="w-9 shrink-0 text-right tabular-nums text-ed-text-2">
								{Math.round(clipVolume(props.segment) * 100)}%
							</span>
						</div>
						<Show
							when={!normalSpeed()}
							fallback={
								<ClipMenuToggleRow
									icon={<IconLucideVolumeX />}
									label="Mute clip"
									description="Silence this clip's audio"
									checked={muted()}
									onChange={(checked) =>
										projectActions.setClipSegmentMuted(props.index, checked)
									}
								/>
							}
						>
							<ClipMenuChips
								label="Audio at this speed"
								options={
									[
										["mute", "Mute"],
										["maintainPitch", "Keep pitch"],
										["matchSpeed", "Match speed"],
									] as const
								}
								value={props.segment.speedAudioMode ?? "mute"}
								onChange={(mode) =>
									projectActions.setClipSegmentSpeedAudioMode(props.index, mode)
								}
							/>
						</Show>
					</ClipMenuSection>

					<ClipMenuSection name="Cursor">
						<ClipMenuToggleRow
							icon={<IconLucideMousePointerBan />}
							label="Hide cursor"
							description="Fades out while this clip plays"
							checked={cursorHidden()}
							onChange={(checked) =>
								projectActions.setClipSegmentHideCursor(props.index, checked)
							}
						/>
					</ClipMenuSection>

					<div class="h-px bg-ed-line" />

					<div class="flex flex-col gap-0.5">
						<ClipMenuRow
							icon={<IconLucideScissors />}
							label="Split at playhead"
							kbd="C"
							hint="Move the playhead into this clip"
							disabled={!canSplitAtPlayhead()}
							onClick={() => {
								projectActions.splitClipSegment(playheadTime(), props.index);
								close();
							}}
						/>
						<ClipMenuRow
							icon={<IconLucideArrowLeftToLine />}
							label="Merge with previous clip"
							hint={mergeHint("previous")}
							disabled={mergeBlocker("previous") !== null}
							onClick={() => {
								projectActions.mergeClipSegment(props.index, "previous");
								close();
							}}
						/>
						<ClipMenuRow
							icon={<IconLucideArrowRightToLine />}
							label="Merge with next clip"
							hint={mergeHint("next")}
							disabled={mergeBlocker("next") !== null}
							onClick={() => {
								projectActions.mergeClipSegment(props.index, "next");
								close();
							}}
						/>
						<Show
							when={renaming()}
							fallback={
								<ClipMenuRow
									icon={<IconLucidePencil />}
									label="Rename clip"
									onClick={startRename}
								/>
							}
						>
							<div class="flex items-center gap-1.5 px-1 py-0.5">
								<TextInput
									ref={(el) => {
										queueMicrotask(() => {
											el.focus();
											el.select();
										});
									}}
									class="h-7 min-w-0 flex-1 px-2 text-[12px]"
									value={draftName()}
									placeholder={props.defaultLabel}
									aria-label="Clip name"
									onInput={(event) => setDraftName(event.currentTarget.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											commitRename();
										} else if (event.key === "Escape") {
											event.preventDefault();
											setRenaming(false);
										}
									}}
									onBlur={commitRename}
								/>
							</div>
						</Show>
					</div>

					<div class="h-px bg-ed-line" />

					<ClipMenuRow
						icon={<IconLucideTrash2 />}
						label="Delete clip"
						kbd="⌫"
						hint="Can't delete the only clip"
						disabled={!canDelete()}
						danger
						onClick={() => {
							projectActions.deleteClipSegment(props.index);
							close();
						}}
					/>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}

export function ClipTrack(
	props: Pick<ComponentProps<"div">, "ref"> & {
		handleUpdatePlayhead: (e: MouseEvent) => void;
	},
) {
	const {
		project,
		setProject,
		projectActions,
		editorInstance,
		projectHistory,
		editorState,
		setEditorState,
		totalDuration,
		micWaveforms,
		systemAudioWaveforms,
	} = useEditorContext();

	const { secsPerPixel, duration, isSegmentVisible } = useTimelineContext();
	const setPreviewTime = useSetPreviewTime();

	const segments = (): Array<TimelineSegment> =>
		project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];
	const [transitionDrag, setTransitionDrag] = createSignal<{
		index: number;
		duration: number;
	} | null>(null);
	const selectedClipIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "clip") return null;
		return new Set(selection.indices);
	});
	const totalClipTimelineDuration = createMemo(() => {
		return clipTimelineDuration(
			segments(),
			project.timeline?.transitions ?? [],
		);
	});
	const effectiveTransitions = createMemo(() =>
		clipTransitionMap(segments(), project.timeline?.transitions ?? []),
	);

	const segmentOffsets = createMemo(() => {
		const segs = segments();
		const transitions = project.timeline?.transitions ?? [];
		const offsets = clipTimelineOffsets(segs, transitions);
		const drag = transitionDrag();
		if (drag) {
			const committed =
				getClipTransition(segs, transitions, drag.index)?.duration ?? 0;
			const shift = committed - drag.duration;
			for (let index = drag.index; index < offsets.length; index++) {
				offsets[index] += shift;
			}
		}
		return offsets;
	});

	const transitionAt = (index: number) => {
		const drag = transitionDrag();
		const transition = effectiveTransitions()[index] ?? null;
		if (drag?.index !== index) return transition;
		if (drag.duration === 0) return null;
		return {
			segmentIndex: index,
			type: transition?.type ?? ("cross-fade" as const),
			duration: drag.duration,
		};
	};

	// Fullscreen text segments pause the recording clock, stretching the clip
	// that contains them across the held window on the output timeline.
	const heldWindows = createMemo(() =>
		holdWindows(project.timeline?.textSegments),
	);

	const selectedHoldWindows = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (selection?.type !== "text") return null;
		const texts = project.timeline?.textSegments;
		if (!texts) return null;
		const windows = selection.indices
			.map((index) => texts[index])
			.filter(
				(segment) =>
					segment &&
					segment.enabled !== false &&
					segment.layout === "fullscreen",
			)
			.map((segment): [number, number] => [segment.start, segment.end]);
		return windows.length > 0 ? windows : null;
	});

	const visibleSegmentIndices = createMemo(() => {
		const segs = segments();
		const offsets = segmentOffsets();
		const holds = heldWindows();
		const draggedIndex = transitionDrag()?.index;
		const visible: number[] = [];
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			const segStart = effectiveToOutput(holds, offsets[i]);
			const segEnd = effectiveToOutput(
				holds,
				offsets[i] + (seg.end - seg.start) / seg.timescale,
			);
			if (i === draggedIndex || isSegmentVisible(segStart, segEnd)) {
				visible.push(i);
			}
		}
		return visible;
	});

	function onHandleReleased() {
		projectActions.normalizeClipTransitions();
		const { transform } = editorState.timeline;

		if (transform.position + transform.zoom > totalDuration() + 4) {
			transform.updateZoom(
				totalDuration(),
				editorState.previewTime ?? editorState.playbackTime,
			);
		}
	}

	const hasMultipleRecordingSegments = () =>
		editorInstance.recordings.segments.length > 1;

	const split = () => editorState.timeline.interactMode === "split";

	createEffect(() => {
		if (!split()) setEditorState("timeline", "splitPreview", null);
	});

	function selectClip(currentIndex: number, event: MouseEvent) {
		const selection = editorState.timeline.selection;
		const isMac = navigator.platform.toUpperCase().includes("MAC");
		const isMultiSelect = isMac ? event.metaKey : event.ctrlKey;

		if (event.shiftKey && selection?.type === "clip") {
			const lastIndex = selection.indices.at(-1) ?? currentIndex;
			const start = Math.min(lastIndex, currentIndex);
			const end = Math.max(lastIndex, currentIndex);
			setEditorState("timeline", "selection", {
				type: "clip",
				indices: Array.from({ length: end - start + 1 }, (_, i) => start + i),
			});
		} else if (isMultiSelect && selection?.type === "clip") {
			const indices = selection.indices.includes(currentIndex)
				? selection.indices.filter((index) => index !== currentIndex)
				: [...selection.indices, currentIndex];
			setEditorState(
				"timeline",
				"selection",
				indices.length > 0 ? { type: "clip", indices } : null,
			);
		} else {
			setEditorState("timeline", "selection", {
				type: "clip",
				indices: [currentIndex],
			});
		}

		props.handleUpdatePlayhead(event);
	}

	return (
		<TrackRoot
			ref={props.ref}
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "clip")}
			onMouseLeave={() => {
				setEditorState("timeline", "hoveredTrack", null);
				setEditorState("timeline", "splitPreview", null);
			}}
		>
			<Index each={visibleSegmentIndices()}>
				{(segmentIndex) => {
					const i = segmentIndex;
					const segment = () => segments()[i()];
					const [speedOpen, setSpeedOpen] = createSignal(false);
					const [menuAnchor, setMenuAnchor] =
						createSignal<ClipMenuAnchor | null>(null);
					const setMenuOpen = (open: boolean) => {
						setSpeedOpen(open);
						if (!open) setMenuAnchor(null);
					};

					const defaultClipName = () =>
						hasMultipleRecordingSegments()
							? `Clip ${segment().recordingSegment}`
							: "Clip";
					const clipName = () => segment().name?.trim() || defaultClipName();

					const speedControl = (triggerClass?: string) => (
						<ClipSettingsControl
							index={i()}
							segment={segment()}
							label={clipName()}
							defaultLabel={defaultClipName()}
							box={relativeSegment()}
							open={speedOpen()}
							anchor={menuAnchor()}
							onOpenChange={setMenuOpen}
							triggerClass={triggerClass}
						/>
					);

					const clipTitle = () => {
						const seg = segment();
						const parts = [clipName(), formatTime(seg.end - seg.start)];
						if (seg.timescale !== 1) parts.push(`${seg.timescale}x`);
						if (clipAudioMuted(seg) || clipVolume(seg) === 0)
							parts.push("Muted");
						else if (clipVolume(seg) !== 1)
							parts.push(`${Math.round(clipVolume(seg) * 100)}% volume`);
						if (seg.hideCursor) parts.push("Cursor hidden");
						return parts.join(" · ");
					};

					const [startHandleDrag, setStartHandleDrag] = createSignal<null | {
						offset: number;
						initialStart: number;
					}>(null);

					const prevDuration = createMemo(() => segmentOffsets()[i()] ?? 0);

					const relativeSegment = createMemo(() => {
						const ds = startHandleDrag();
						const offset = ds?.offset ?? 0;
						const seg = segment();
						const holds = heldWindows();

						return {
							start: Math.max(
								effectiveToOutput(holds, prevDuration() + offset),
								0,
							),
							end: effectiveToOutput(
								holds,
								prevDuration() +
									(offset + (seg.end - seg.start)) / seg.timescale,
							),
							timescale: seg.timescale,
							recordingSegment: seg.recordingSegment,
						};
					});

					// Held (paused) windows inside this clip's on-screen box.
					const segmentHolds = createMemo(() => {
						const { start, end } = relativeSegment();
						return heldWindows()
							.map(([holdStart, holdEnd]): [number, number] => [
								Math.max(holdStart, start),
								Math.min(holdEnd, end),
							])
							.filter(([holdStart, holdEnd]) => holdEnd > holdStart);
					});

					const segmentX = useSegmentTranslateX(relativeSegment);
					const segmentWidth = useSegmentWidth(relativeSegment);

					const splitTimeAt = (e: {
						clientX: number;
						altKey: boolean;
						currentTarget: HTMLDivElement;
					}) => {
						const rect = e.currentTarget.getBoundingClientRect();
						const seg = relativeSegment();
						const raw = seg.start + (e.clientX - rect.left) * secsPerPixel();
						if (e.altKey) return { time: raw, snapped: null };
						return snapSplitTime(
							raw,
							seg.start,
							seg.end,
							SPLIT_SNAP_PX * secsPerPixel(),
							project.timeline,
							editorState.playbackTime,
						);
					};

					const segmentRecording = (s = i()) =>
						editorInstance.recordings.segments[
							segments()[s].recordingSegment ?? 0
						];

					const marker = useSectionMarker(() => ({
						segments: segments(),
						i: i(),
						position: "left",
					}));

					const endMarker = useSectionMarker(() => ({
						segments: segments(),
						i: i(),
						position: "right",
					}));

					const isSelected = createMemo(() => {
						const indices = selectedClipIndices();
						if (!indices) return false;
						return indices.has(i());
					});

					const micWaveform = () => {
						if (project.audio.micVolumeDb && project.audio.micVolumeDb < -30)
							return;

						const idx = segment().recordingSegment ?? i();
						return micWaveforms()?.[idx] ?? [];
					};

					const systemAudioWaveform = () => {
						if (
							project.audio.systemVolumeDb &&
							project.audio.systemVolumeDb < -30
						)
							return;

						const idx = segment().recordingSegment ?? i();
						return systemAudioWaveforms()?.[idx] ?? [];
					};

					return (
						<>
							<Show when={marker()}>
								{(marker) => (
									<div
										class="absolute w-0 z-10 h-full *:absolute"
										style={{
											transform: `translateX(${segmentX()}px)`,
										}}
									>
										<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-linear-to-b -translate-x-1/2" />
										<Switch>
											<Match
												when={(() => {
													const m = marker();
													if (m.type === "single") return m.value;
												})()}
											>
												{(markerValue) => {
													const value = createMemo(() => {
														const m = markerValue();
														return m.type === "time" ? m.time : 0;
													});

													return (
														<div class="overflow-hidden -top-8 z-10 h-7 rounded-full -translate-x-1/2">
															<CutOffsetButton
																value={value()}
																onClick={() => {
																	setProject(
																		"timeline",
																		"segments",
																		produce((s) => {
																			if (markerValue().type === "reset") {
																				s[i() - 1].end = s[i()].end;
																				s.splice(i(), 1);
																			} else {
																				s[i() - 1].end = s[i()].start;
																			}
																		}),
																	);
																}}
															/>
														</div>
													);
												}}
											</Match>
											<Match
												when={(() => {
													const m = marker();
													if (
														m.type === "dual" &&
														m.right &&
														m.right.type === "time"
													)
														return m.right;
												})()}
											>
												{(markerValue) => {
													const value = createMemo(() => {
														const m = markerValue();
														return m.type === "time" ? m.time : 0;
													});

													return (
														<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
															<CutOffsetButton
																value={value()}
																class="-left-px absolute rounded-r-full pl-1.5! rounded-tl-full"
																onClick={() => {
																	setProject(
																		"timeline",
																		"segments",
																		i(),
																		"start",
																		0,
																	);
																}}
															/>
														</div>
													);
												}}
											</Match>
										</Switch>
									</div>
								)}
							</Show>
							<SegmentRoot
								segColor="var(--track-clip)"
								class="group"
								selected={isSelected()}
								title={clipTitle()}
								segment={relativeSegment()}
								onMouseMove={(e) => {
									if (editorState.timeline.interactMode !== "split") return;
									const result = splitTimeAt(e);
									setEditorState("timeline", "splitPreview", {
										time: result.time,
										snapped: result.snapped !== null,
									});
								}}
								onMouseLeave={() => {
									if (editorState.timeline.splitPreview)
										setEditorState("timeline", "splitPreview", null);
								}}
								onContextMenu={(e) => {
									e.preventDefault();
									e.stopPropagation();
									if (split()) return;
									const index = i();
									const selection = editorState.timeline.selection;
									if (
										selection?.type !== "clip" ||
										!selection.indices.includes(index)
									) {
										setEditorState("timeline", "selection", {
											type: "clip",
											indices: [index],
										});
									}
									setMenuAnchor({ x: e.clientX, y: e.clientY });
									setSpeedOpen(true);
								}}
								onMouseDown={(e) => {
									e.stopPropagation();
									if (e.button !== 0) return;
									if (
										(e.target as HTMLElement).closest(
											"[data-clip-handle], [data-transition]",
										)
									)
										return;

									if (editorState.timeline.interactMode === "split") {
										// The box is in output time (it stretches across any
										// held windows); splitClipSegment converts back to the
										// recording-flow domain itself.
										projectActions.splitClipSegment(splitTimeAt(e).time, i());
									} else {
										const index = i();
										const initialTransition = getClipTransition(
											segments(),
											project.timeline?.transitions ?? [],
											index,
										);
										const initialDuration = initialTransition?.duration ?? 0;
										const canDrag =
											index > 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey;
										const startX = e.clientX;
										let active = false;
										let nextDuration = initialDuration;
										let pendingX = startX;
										let frame: number | null = null;

										const update = () => {
											frame = null;
											const delta = pendingX - startX;
											if (!active) {
												if (!canDrag || Math.abs(delta) < 4) return;
												if (!initialTransition && delta > 0) return;
												active = true;
											}

											const requested =
												initialDuration - delta * secsPerPixel();
											nextDuration =
												requested < MIN_CLIP_TRANSITION_DURATION / 2
													? 0
													: clampTransitionDuration(
															requested || DEFAULT_CLIP_TRANSITION_DURATION,
															segments()[index - 1],
															segments()[index],
														);
											setTransitionDrag({ index, duration: nextDuration });
										};

										createRoot((dispose) => {
											onCleanup(() => {
												if (frame !== null) cancelAnimationFrame(frame);
											});
											createEventListenerMap(window, {
												mousemove: (event) => {
													pendingX = event.clientX;
													if (frame === null)
														frame = requestAnimationFrame(update);
												},
												mouseup: (event) => {
													pendingX = event.clientX;
													if (frame !== null) {
														cancelAnimationFrame(frame);
														frame = null;
													}
													update();
													if (active) {
														projectActions.setClipTransition(
															index,
															nextDuration > 0
																? {
																		type:
																			initialTransition?.type ?? "cross-fade",
																		duration: nextDuration,
																	}
																: null,
														);
														setEditorState(
															"timeline",
															"selection",
															nextDuration > 0
																? { type: "transition", index }
																: null,
														);
														setTransitionDrag(null);
													} else {
														selectClip(index, event);
													}
													dispose();
												},
												blur: () => {
													setTransitionDrag(null);
													dispose();
												},
											});
										});
									}
								}}
							>
								{segment().timescale === 1 &&
									!clipAudioMuted(segment()) &&
									clipVolume(segment()) > 0 && (
										<WaveformCanvas
											micWaveform={micWaveform()}
											systemWaveform={systemAudioWaveform()}
											segment={segment()}
											segmentOffset={relativeSegment().start}
											holds={segmentHolds()}
										/>
									)}

								<Markings
									segment={segment()}
									prevDuration={relativeSegment().start}
									holds={segmentHolds()}
								/>

								<For each={segmentHolds()}>
									{(hold) => {
										// Light up when the fullscreen text causing this hold
										// is selected, so cause and effect read as one thing.
										const causeSelected = () =>
											selectedHoldWindows()?.some(
												([start, end]) => start < hold[1] && end > hold[0],
											) ?? false;
										const holdWidth = () =>
											(hold[1] - hold[0]) / secsPerPixel();
										return (
											<div
												class={cx(
													"absolute inset-y-0 z-[3] flex items-center justify-center gap-1 overflow-hidden bg-ed-card/75 backdrop-saturate-50 border-x transition-colors",
													causeSelected()
														? "border-ed-accent"
														: "border-ed-line-strong",
												)}
												style={{
													left: `${(hold[0] - relativeSegment().start) / secsPerPixel()}px`,
													width: `${holdWidth()}px`,
													"background-image":
														"repeating-linear-gradient(-45deg, rgba(127,127,127,0.12) 0px, rgba(127,127,127,0.12) 4px, transparent 4px, transparent 8px)",
												}}
												title="Video paused while the fullscreen text is shown"
											>
												<IconLucidePause
													class={cx(
														"size-3 shrink-0",
														causeSelected()
															? "text-ed-accent"
															: "text-ed-text-3",
													)}
												/>
												<Show when={holdWidth() >= 64}>
													<span
														class={cx(
															"text-[10px] font-medium whitespace-nowrap",
															causeSelected()
																? "text-ed-accent"
																: "text-ed-text-3",
														)}
													>
														Paused
													</span>
												</Show>
											</div>
										);
									}}
								</For>

								<Show when={i() > 0 && !transitionAt(i())}>
									<button
										type="button"
										data-transition
										class="absolute inset-y-0 left-0 z-[4] grid w-4 -translate-x-1/2 place-items-center bg-ed-accent/40 text-xs text-white opacity-0 transition-opacity hover:bg-ed-accent/60 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ed-accent"
										aria-label={`Add transition before clip ${i() + 1}`}
										onClick={(event) => {
											event.stopPropagation();
											projectActions.setClipTransition(i(), {
												type: "cross-fade",
												duration: DEFAULT_CLIP_TRANSITION_DURATION,
											});
											setEditorState("timeline", "selection", {
												type: "transition",
												index: i(),
											});
										}}
									>
										+
									</button>
								</Show>

								<Show when={transitionAt(i())}>
									{(transition) => (
										<Popover
											placement="top"
											gutter={8}
											open={
												editorState.timeline.selection?.type === "transition" &&
												editorState.timeline.selection.index === i()
											}
											onOpenChange={(open) =>
												setEditorState(
													"timeline",
													"selection",
													open ? { type: "transition", index: i() } : null,
												)
											}
										>
											<Popover.Trigger
												data-transition
												class={cx(
													"absolute inset-y-0 left-0 z-[5] overflow-hidden border-x border-ed-accent/60 bg-ed-accent/20 transition-colors hover:bg-ed-accent/35",
													editorState.timeline.selection?.type ===
														"transition" &&
														editorState.timeline.selection.index === i() &&
														"bg-ed-accent/45 ring-1 ring-inset ring-ed-accent",
												)}
												style={{
													width: `${transition().duration / secsPerPixel()}px`,
													"background-image":
														"linear-gradient(135deg, transparent 42%, rgb(96 165 250 / 0.7) 43%, rgb(96 165 250 / 0.7) 57%, transparent 58%)",
												}}
												title={`${transition().type === "cross-fade" ? "Crossfade" : "Fade through black"} · ${transition().duration.toFixed(2)}s`}
												onMouseDown={(event) => event.stopPropagation()}
											>
												<span class="sr-only">Edit clip transition</span>
											</Popover.Trigger>
											<Popover.Portal>
												<Popover.Content
													onMouseDown={(event) => event.stopPropagation()}
													class="z-50 flex w-64 flex-col gap-3 rounded-xl bg-ed-card p-3 text-ed-text-1 shadow-ed-pop outline-hidden"
												>
													<div class="flex items-center justify-between">
														<span class="text-sm font-medium">
															Clip transition
														</span>
														<span class="text-xs tabular-nums text-gray-10">
															{transition().duration.toFixed(2)}s
														</span>
													</div>
													<div class="grid grid-cols-2 gap-1 rounded-lg bg-gray-2 p-1">
														{(
															[
																["cross-fade", "Crossfade"],
																["fade-through-black", "Fade"],
															] as const
														).map(([type, label]) => (
															<button
																type="button"
																aria-pressed={transition().type === type}
																class={cx(
																	"rounded-md px-2 py-1.5 text-xs transition-colors",
																	transition().type === type
																		? "bg-gray-4 text-gray-12"
																		: "text-gray-10 hover:text-gray-12",
																)}
																onClick={() =>
																	projectActions.setClipTransition(i(), {
																		type,
																		duration: transition().duration,
																	})
																}
															>
																{label}
															</button>
														))}
													</div>
													<input
														type="range"
														aria-label="Transition duration"
														min={MIN_CLIP_TRANSITION_DURATION}
														max={maxTransitionDuration(
															segments()[i() - 1],
															segment(),
														)}
														step={0.05}
														value={transition().duration}
														onChange={(event) =>
															projectActions.setClipTransition(i(), {
																type: transition().type,
																duration: event.currentTarget.valueAsNumber,
															})
														}
													/>
													<button
														type="button"
														class="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10"
														onClick={() =>
															projectActions.deleteClipTransition(i())
														}
													>
														Remove transition
													</button>
												</Popover.Content>
											</Popover.Portal>
										</Popover>
									)}
								</Show>

								<SegmentHandle
									position="start"
									data-clip-handle
									onMouseDown={(downEvent) => {
										if (split()) return;
										const seg = segment();
										const minRecordedDuration = Math.max(
											1,
											secsPerPixel() *
												MIN_CLIP_SEGMENT_PIXEL_WIDTH *
												seg.timescale,
											Math.max(
												effectiveTransitions()[i()]?.duration ?? 0,
												effectiveTransitions()[i() + 1]?.duration ?? 0,
											) *
												2 *
												seg.timescale,
										);

										const initialStart = seg.start;
										setStartHandleDrag({
											offset: 0,
											initialStart,
										});

										const maxSegmentDuration =
											editorInstance.recordings.segments[
												seg.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											(totalClipTimelineDuration() -
												(seg.end - seg.start) / seg.timescale);

										const maxDuration = Math.min(
											maxSegmentDuration,
											availableTimelineDuration,
										);

										const prevSegment = segments()[i() - 1];
										const prevSegmentIsSameClip =
											prevSegment?.recordingSegment !== undefined
												? prevSegment.recordingSegment === seg.recordingSegment
												: false;

										function update(event: MouseEvent) {
											const newStart =
												initialStart +
												(event.clientX - downEvent.clientX) *
													secsPerPixel() *
													seg.timescale;

											const clampedStart = Math.min(
												Math.max(
													newStart,
													prevSegmentIsSameClip ? prevSegment.end : 0,
													seg.end - maxDuration,
												),
												seg.end - minRecordedDuration,
											);

											setStartHandleDrag({
												offset: clampedStart - initialStart,
												initialStart,
											});

											batch(() => {
												setProject(
													"timeline",
													"segments",
													i(),
													"start",
													clampedStart,
												);
												setPreviewTime(prevDuration());
											});
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											onCleanup(() => {
												resumeHistory();
												setStartHandleDrag(null);
												onHandleReleased();
											});

											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													update(e);
													dispose();
												},
												blur: () => dispose(),
												mouseleave: () => dispose(),
											});
										});
									}}
								/>
								<SegmentContent class="relative items-center">
									<SegmentLabel
										full={() => (
											<div class="cap-seg-labels">
												<span class="cap-seg-label truncate">{clipName()}</span>
												<span class="cap-seg-sublabel">
													{formatTime(segment().end - segment().start)}
												</span>
												{speedControl("shrink-0")}
											</div>
										)}
										compact={() => (
											<div class="cap-seg-labels">
												{speedControl("shrink-0")}
												<span class="cap-seg-sublabel truncate">
													{formatTime(segment().end - segment().start)}
												</span>
											</div>
										)}
										glyph={() => speedControl("shrink-0")}
									/>
								</SegmentContent>
								<SegmentHandle
									position="end"
									data-clip-handle
									onMouseDown={(downEvent) => {
										const seg = segment();
										const end = seg.end;
										const minRecordedDuration = Math.max(
											1,
											secsPerPixel() *
												MIN_CLIP_SEGMENT_PIXEL_WIDTH *
												seg.timescale,
											Math.max(
												effectiveTransitions()[i()]?.duration ?? 0,
												effectiveTransitions()[i() + 1]?.duration ?? 0,
											) *
												2 *
												seg.timescale,
										);

										if (split()) return;
										const maxSegmentDuration =
											editorInstance.recordings.segments[
												seg.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											(totalClipTimelineDuration() -
												(seg.end - seg.start) / seg.timescale);

										const nextSegment = segments()[i() + 1];
										const nextSegmentIsSameClip =
											nextSegment?.recordingSegment !== undefined
												? nextSegment.recordingSegment === seg.recordingSegment
												: false;

										function update(event: MouseEvent) {
											const deltaRecorded =
												(event.clientX - downEvent.clientX) *
												secsPerPixel() *
												seg.timescale;
											const newEnd = end + deltaRecorded;
											const clampedEnd = Math.max(
												Math.min(
													newEnd,
													end + availableTimelineDuration * seg.timescale,
													nextSegmentIsSameClip
														? nextSegment.start
														: maxSegmentDuration,
												),
												seg.start + minRecordedDuration,
											);

											batch(() => {
												setProject(
													"timeline",
													"segments",
													i(),
													"end",
													clampedEnd,
												);
												setPreviewTime(
													prevDuration() +
														(clampedEnd - seg.start) / seg.timescale,
												);
											});
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													dispose();
													resumeHistory();
													update(e);
													onHandleReleased();
												},
												blur: () => {
													dispose();
													resumeHistory();
													onHandleReleased();
												},
												mouseleave: () => {
													dispose();
													resumeHistory();
													onHandleReleased();
												},
											});
										});
									}}
								/>
							</SegmentRoot>
							<Show
								when={(() => {
									const m = endMarker();
									if (m?.type === "dual" && m.left && m.left.type === "time")
										return m.left;
								})()}
							>
								{(markerValue) => {
									const value = createMemo(() => {
										const m = markerValue();
										return m.type === "time" ? m.time : 0;
									});

									return (
										<div
											class="absolute w-0 z-10 h-full *:absolute"
											style={{
												transform: `translateX(${segmentX() + segmentWidth()}px)`,
											}}
										>
											<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-linear-to-b -translate-x-1/2" />
											<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
												<CutOffsetButton
													value={value()}
													class="-right-px absolute rounded-l-full pr-1.5! rounded-tr-full"
													onClick={() => {
														setProject(
															"timeline",
															"segments",
															i(),
															"end",
															segmentRecording().display.duration,
														);
													}}
												/>
											</div>
										</div>
									);
								}}
							</Show>
						</>
					);
				}}
			</Index>
		</TrackRoot>
	);
}

function Markings(props: {
	segment: TimelineSegment;
	prevDuration: number;
	holds: ReadonlyArray<[number, number]>;
}) {
	const { editorState } = useEditorContext();
	const { secsPerPixel, markingResolution } = useTimelineContext();

	const transform = () => editorState.timeline.transform;

	const markingParams = () => {
		const resolution = markingResolution();
		const visibleMin =
			transform().position - props.prevDuration + props.segment.start;
		const visibleMax = visibleMin + transform().zoom;
		const start = Math.floor(visibleMin / resolution);
		const count = Math.ceil(visibleMax / resolution) - start;
		return { resolution, start, count };
	};

	const getMarkingTime = (index: number) => {
		const { resolution, start } = markingParams();
		return (start + index) * resolution;
	};

	return (
		<Index each={Array.from({ length: markingParams().count })}>
			{(_, index) => {
				const marking = () => getMarkingTime(index);
				// Markings live in recording time; push each past the holds the
				// stretched box inserts before it.
				const translateX = () => {
					const holdsRel = props.holds.map(([start, end]): [number, number] => [
						start - props.prevDuration,
						end - props.prevDuration,
					]);
					const effective = marking() - props.segment.start;
					return effectiveToOutput(holdsRel, effective) / secsPerPixel();
				};

				return (
					<div
						style={{
							transform: `translateX(${translateX()}px)`,
						}}
						class="absolute inset-y-0 z-10 w-px bg-linear-to-b from-transparent to-transparent via-ed-line-strong"
					/>
				);
			}}
		</Index>
	);
}

function CutOffsetButton(props: {
	value: number;
	class?: string;
	onClick?(): void;
}) {
	return (
		<button
			class={cx(
				"h-7 bg-red-300 text-nowrap hover:bg-red-400 text-xs tabular-nums text-white p-2 flex flex-row items-center transition-colors",
				props.class,
			)}
			onClick={() => props.onClick?.()}
		>
			<Show
				when={props.value !== 0}
				fallback={<IconCapScissors class="size-3.5" />}
			>
				{formatTime(props.value)}
			</Show>
		</button>
	);
}

function useSectionMarker(
	props: () => {
		segments: TimelineSegment[];
		i: number;
		position: "left" | "right";
	},
) {
	const { editorInstance } = useEditorContext();

	return () => getSectionMarker(props(), editorInstance.recordings.segments);
}
