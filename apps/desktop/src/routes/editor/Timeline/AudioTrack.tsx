import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, createSignal, For, Show } from "solid-js";
import { produce } from "solid-js/store";

import { type AudioTrackSegment, MIN_AUDIO_SEGMENT_DURATION } from "../audio";
import { useEditorContext } from "../context";
import { getSegmentTrack, sortTrackSegments } from "../timelineTracks";
import { useTimelineContext } from "./context";
import {
	SegmentContent,
	SegmentHandle,
	SegmentLabel,
	SegmentRoot,
	TrackRoot,
	useSetPreviewTime,
} from "./Track";

export type AudioSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_SEGMENT_PIXELS = 60;

function computeMovedAudioSegment(
	original: AudioTrackSegment,
	delta: number,
	total: number,
	minDur: number,
) {
	const rawStart = original.start + delta;
	const rawEnd = original.end + delta;
	const trimStart = original.trimStart + Math.max(0, -rawStart);
	const start = Math.max(0, rawStart);
	let end = rawEnd;

	end = Math.min(end, total);

	if (original.duration != null && original.duration > 0) {
		const maxEnd = start + (original.duration - trimStart);
		end = Math.min(end, maxEnd);
	}

	if (end - start < minDur) {
		if (end >= total - 1e-6) {
			return {
				start: Math.max(0, end - minDur),
				end,
				trimStart,
			};
		}
		return {
			start,
			end: start + minDur,
			trimStart,
		};
	}

	return { start, end, trimStart };
}

function fadeGeometry(frac: number, edge: "in" | "out") {
	const span = Math.max(0, Math.min(1, frac)) * 100;
	const boundaryX = edge === "in" ? span : 100 - span;
	return {
		span,
		boundaryX,
		shadeX: edge === "in" ? 0 : boundaryX,
		shadeWidth: span,
	};
}

function fadeEnvelopeCurve(edge: "in" | "out", span: number) {
	if (span <= 0) return "";
	if (edge === "in") {
		return `M 0,100 C 0,68 ${span * 0.55},10 ${span},0`;
	}
	const endX = 100 - span;
	return `M 100,100 C 100,68 ${endX + span * 0.45},10 ${endX},0`;
}

function FadeCornerTriangle(props: { edge: "in" | "out" }) {
	return (
		<div
			class={cx(
				"overflow-hidden size-[11px]",
				props.edge === "in" ? "rounded-tl-lg" : "rounded-tr-lg",
			)}
		>
			<svg class="block size-full" viewBox="0 0 11 11" aria-hidden="true">
				{props.edge === "in" ? (
					<>
						<polygon class="cap-fade-corner" points="0,0 11,0 0,11" />
						<line
							class="cap-fade-corner-line"
							x1="11"
							y1="0"
							x2="0"
							y2="11"
							stroke-width="0.75"
						/>
					</>
				) : (
					<>
						<polygon class="cap-fade-corner" points="11,0 0,0 11,11" />
						<line
							class="cap-fade-corner-line"
							x1="0"
							y1="0"
							x2="11"
							y2="11"
							stroke-width="0.75"
						/>
					</>
				)}
			</svg>
		</div>
	);
}

function FadeControl(props: {
	edge: "in" | "out";
	frac: number;
	fadeSeconds: number;
	active: boolean;
	onMouseDown: (e: MouseEvent) => void;
	onDblClick: (e: MouseEvent) => void;
}) {
	const hasFade = () => props.frac > 0.001;
	const showEnvelope = () => hasFade() || props.active;
	const geometry = () => fadeGeometry(props.frac, props.edge);
	const showCorner = () => hasFade() || props.active;

	return (
		<>
			<Show when={showEnvelope()}>
				<Show when={geometry().span > 0}>
					<svg
						class="absolute inset-0 w-full h-full pointer-events-none z-20"
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						<rect
							class="cap-fade-shade"
							x={geometry().shadeX}
							y="0"
							width={geometry().shadeWidth}
							height="100"
						/>
						<path
							class="cap-fade-curve"
							d={fadeEnvelopeCurve(props.edge, geometry().span)}
							fill="none"
							stroke-width="1.5"
							vector-effect="non-scaling-stroke"
						/>
					</svg>
				</Show>
				<div
					role="slider"
					aria-label={
						props.edge === "in" ? "Fade in duration" : "Fade out duration"
					}
					aria-valuenow={Math.round(props.fadeSeconds * 1000)}
					tabindex={-1}
					class="timeline-fade-cursor absolute inset-y-0 z-40 w-5 -translate-x-1/2 pointer-events-auto"
					style={{
						left: `${Math.max(geometry().boundaryX, props.active ? 0.5 : 0)}%`,
					}}
					onMouseDown={props.onMouseDown}
					onDblClick={props.onDblClick}
				>
					<div class="absolute top-0 left-1/2 -translate-x-1/2 bg-ed-card ring-1 ring-ed-line-strong shadow-sm pointer-events-none size-2.5" />
				</div>
			</Show>

			<div
				class={cx(
					"absolute top-0 z-40 pointer-events-auto",
					props.edge === "in" ? "left-0" : "right-0",
					showCorner()
						? "opacity-100"
						: "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
				)}
			>
				<div
					role="slider"
					aria-label={
						props.edge === "in" ? "Fade in corner" : "Fade out corner"
					}
					aria-valuenow={Math.round(props.fadeSeconds * 1000)}
					tabindex={-1}
					class="timeline-fade-cursor relative p-2 -m-2"
					onMouseDown={props.onMouseDown}
					onDblClick={props.onDblClick}
				>
					<FadeCornerTriangle edge={props.edge} />
				</div>
			</div>
		</>
	);
}

export function AudioTrack(props: {
	laneIndex: number;
	onDragStateChanged: (v: AudioSegmentDragState) => void;
	handleUpdatePlayhead: (e: MouseEvent) => void;
	onRequestAdd: (laneIndex: number) => void;
}) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		totalDuration,
		projectHistory,
		projectActions,
	} = useEditorContext();
	const { secsPerPixel } = useTimelineContext();
	const setPreviewTime = useSetPreviewTime();
	const [draggingIndex, setDraggingIndex] = createSignal<number | null>(null);
	const [fadeDrag, setFadeDrag] = createSignal<{
		index: number;
		edge: "in" | "out";
	} | null>(null);

	const minDuration = () =>
		Math.max(MIN_AUDIO_SEGMENT_DURATION, secsPerPixel() * MIN_SEGMENT_PIXELS);

	const audioSegments = () => project.timeline?.audioSegments ?? [];
	const laneSegments = createMemo(() =>
		audioSegments()
			.map((segment, index) => ({ segment, index }))
			.filter(({ segment }) => getSegmentTrack(segment) === props.laneIndex),
	);
	const selectedAudioIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "audio") return null;
		return new Set(selection.indices);
	});

	function createMouseDownDrag<T>(
		segmentIndex: () => number,
		setup: () => T,
		update: (e: MouseEvent, value: T, initialMouseX: number) => void,
	) {
		return (downEvent: MouseEvent) => {
			if (editorState.timeline.interactMode !== "seek") return;
			downEvent.stopPropagation();
			const initial = setup();
			let moved = false;
			let initialMouseX: number | null = null;

			const resumeHistory = projectHistory.pause();
			props.onDragStateChanged({ type: "movePending" });

			function finish(e: MouseEvent) {
				resumeHistory();
				setDraggingIndex(null);
				if (!moved) {
					e.stopPropagation();
					setEditorState("timeline", "audioPicker", null);
					const currentSelection = editorState.timeline.selection;
					const index = segmentIndex();
					const isMultiSelect = e.ctrlKey || e.metaKey;
					const isRangeSelect = e.shiftKey;

					if (isRangeSelect && currentSelection?.type === "audio") {
						const existingIndices = currentSelection.indices;
						const lastIndex = existingIndices[existingIndices.length - 1];
						const start = Math.min(lastIndex, index);
						const end = Math.max(lastIndex, index);
						const rangeIndices: number[] = [];
						for (let idx = start; idx <= end; idx++) rangeIndices.push(idx);
						setEditorState("timeline", "selection", {
							type: "audio",
							indices: rangeIndices,
						});
					} else if (isMultiSelect) {
						if (currentSelection?.type === "audio") {
							const base = currentSelection.indices;
							const exists = base.includes(index);
							const next = exists
								? base.filter((i) => i !== index)
								: [...base, index];
							setEditorState(
								"timeline",
								"selection",
								next.length > 0 ? { type: "audio", indices: next } : null,
							);
						} else {
							setEditorState("timeline", "selection", {
								type: "audio",
								indices: [index],
							});
						}
					} else {
						setEditorState("timeline", "selection", {
							type: "audio",
							indices: [index],
						});
					}
					props.handleUpdatePlayhead(e);
				}
				props.onDragStateChanged({ type: "idle" });
			}

			function handleUpdate(event: MouseEvent) {
				if (Math.abs(event.clientX - downEvent.clientX) > 2) {
					if (!moved) {
						moved = true;
						initialMouseX = event.clientX;
						setDraggingIndex(segmentIndex());
						props.onDragStateChanged({ type: "moving" });
					}
				}

				if (initialMouseX === null) return;
				update(event, initial, initialMouseX);
			}

			createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: (e) => handleUpdate(e),
					mouseup: (e) => {
						handleUpdate(e);
						finish(e);
						dispose();
					},
				});
			});
		};
	}

	function createFadeDrag(index: number, edge: "in" | "out") {
		return (downEvent: MouseEvent) => {
			if (editorState.timeline.interactMode !== "seek") return;
			downEvent.stopPropagation();
			downEvent.preventDefault();

			const trackEl = (downEvent.currentTarget as HTMLElement).closest(
				".cap-track-fill",
			);
			if (!(trackEl instanceof HTMLElement)) return;

			const resumeHistory = projectHistory.pause();
			setFadeDrag({ index, edge });

			const updateFade = (e: MouseEvent) => {
				const segment = audioSegments()[index];
				if (!segment) return;

				const rect = trackEl.getBoundingClientRect();
				if (rect.width <= 0) return;

				const segmentDuration = segment.end - segment.start;
				const otherFade = edge === "in" ? segment.fadeOut : segment.fadeIn;
				const maxFade = Math.max(0, segmentDuration - otherFade);
				const pointerFrac =
					edge === "in"
						? (e.clientX - rect.left) / rect.width
						: (rect.right - e.clientX) / rect.width;
				const next = Math.max(
					0,
					Math.min(pointerFrac * segmentDuration, maxFade),
				);
				setProject(
					"timeline",
					"audioSegments",
					index,
					edge === "in" ? "fadeIn" : "fadeOut",
					next,
				);
			};

			updateFade(downEvent);

			createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: updateFade,
					mouseup: () => {
						resumeHistory();
						setFadeDrag(null);
						dispose();
					},
				});
			});
		};
	}

	return (
		<TrackRoot
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "audio")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
		>
			<For
				each={laneSegments()}
				fallback={
					<button
						type="button"
						class="cap-empty-lane pointer-events-auto"
						data-active={
							editorState.timeline.audioPicker === props.laneIndex
								? ""
								: undefined
						}
						onMouseDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation();
							props.onRequestAdd(props.laneIndex);
						}}
					>
						<span>Add background music or import your own audio</span>
						<span class="cap-empty-lane-action">· Add audio</span>
					</button>
				}
			>
				{({ segment, index }) => {
					const isSelected = createMemo(() => {
						const indices = selectedAudioIndices();
						if (!indices) return false;
						return indices.has(index);
					});

					const segmentDuration = () =>
						Math.max(segment.end - segment.start, 0.0001);
					const fadeInFrac = () =>
						Math.max(0, Math.min(1, segment.fadeIn / segmentDuration()));
					const fadeOutFrac = () =>
						Math.max(0, Math.min(1, segment.fadeOut / segmentDuration()));
					const isDragging = () => draggingIndex() === index;
					const fadeInActive = () =>
						fadeDrag()?.index === index && fadeDrag()?.edge === "in";
					const fadeOutActive = () =>
						fadeDrag()?.index === index && fadeDrag()?.edge === "out";

					return (
						<SegmentRoot
							data-audio-segment
							data-index={index}
							forceVisible={isDragging()}
							segColor="var(--track-audio)"
							class="group"
							selected={isSelected()}
							muted={!segment.enabled}
							title={segment.name || "Audio"}
							segment={segment}
							onMouseDown={(e) => {
								e.stopPropagation();
								if (editorState.timeline.interactMode === "split") {
									const rect = e.currentTarget.getBoundingClientRect();
									const fraction = (e.clientX - rect.left) / rect.width;
									const splitTime = fraction * (segment.end - segment.start);
									projectActions.splitAudioSegment(index, splitTime);
								}
							}}
						>
							<SegmentHandle
								position="start"
								onMouseDown={createMouseDownDrag(
									() => index,
									() => {
										const start = segment.start;
										const trimStart = segment.trimStart;
										const minValue = Math.max(0, start - trimStart);
										const maxValue = Math.max(
											minValue,
											segment.end - minDuration(),
										);
										return { start, trimStart, minValue, maxValue };
									},
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const next = Math.max(
											value.minValue,
											Math.min(value.maxValue, value.start + delta),
										);
										const trimDelta = next - value.start;
										setProject("timeline", "audioSegments", index, {
											start: next,
											trimStart: Math.max(0, value.trimStart + trimDelta),
										});
										setProject(
											"timeline",
											"audioSegments",
											produce((items) => {
												sortTrackSegments(items ?? []);
											}),
										);
										setPreviewTime(next);
									},
								)}
							/>
							<SegmentContent
								class="relative z-0 flex items-center cursor-grab overflow-hidden"
								onMouseDown={createMouseDownDrag(
									() => index,
									() => ({ original: { ...segment } }),
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const next = computeMovedAudioSegment(
											value.original,
											delta,
											totalDuration(),
											minDuration(),
										);
										setProject("timeline", "audioSegments", index, next);
										setProject(
											"timeline",
											"audioSegments",
											produce((items) => {
												sortTrackSegments(items ?? []);
											}),
										);
									},
								)}
							>
								<SegmentLabel
									compactAt={24}
									full={() => (
										<div class="cap-seg-labels z-10 max-w-full">
											<span class="cap-seg-label max-w-full truncate">
												{segment.name || "Audio"}
											</span>
											<span class="cap-seg-sublabel">
												{`${Math.round(segment.end - segment.start)}s`}
											</span>
										</div>
									)}
									compact={() => (
										<div class="cap-seg-labels z-10 max-w-full">
											<span class="cap-seg-label max-w-full truncate">
												{segment.name || "Audio"}
											</span>
										</div>
									)}
								/>
							</SegmentContent>
							<SegmentHandle
								position="end"
								onMouseDown={createMouseDownDrag(
									() => index,
									() => {
										const end = segment.end;
										const minValue = segment.start + minDuration();
										const sourceLimit =
											segment.duration && segment.duration > 0
												? segment.start + (segment.duration - segment.trimStart)
												: totalDuration();
										const maxValue = Math.max(
											minValue,
											Math.min(totalDuration(), sourceLimit),
										);
										return { end, minValue, maxValue };
									},
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const next = Math.max(
											value.minValue,
											Math.min(value.maxValue, value.end + delta),
										);
										setProject("timeline", "audioSegments", index, "end", next);
										setProject(
											"timeline",
											"audioSegments",
											produce((items) => {
												sortTrackSegments(items ?? []);
											}),
										);
										setPreviewTime(next);
									},
								)}
							/>
							<FadeControl
								edge="in"
								frac={fadeInFrac()}
								fadeSeconds={segment.fadeIn}
								active={fadeInActive()}
								onMouseDown={createFadeDrag(index, "in")}
								onDblClick={(e) => {
									e.stopPropagation();
									setProject("timeline", "audioSegments", index, "fadeIn", 0);
								}}
							/>
							<FadeControl
								edge="out"
								frac={fadeOutFrac()}
								fadeSeconds={segment.fadeOut}
								active={fadeOutActive()}
								onMouseDown={createFadeDrag(index, "out")}
								onDblClick={(e) => {
									e.stopPropagation();
									setProject("timeline", "audioSegments", index, "fadeOut", 0);
								}}
							/>
						</SegmentRoot>
					);
				}}
			</For>
		</TrackRoot>
	);
}
