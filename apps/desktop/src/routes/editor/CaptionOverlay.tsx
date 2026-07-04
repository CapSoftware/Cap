import { createEventListenerMap } from "@solid-primitives/event-listener";
import { throttle } from "@solid-primitives/scheduled";
import {
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	on,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { defaultCaptionSettings } from "~/store/captions";
import type { CaptionTrackSegment } from "~/utils/tauri";
import { FPS, useEditorContext } from "./context";

type CaptionOverlayProps = {
	size: { width: number; height: number };
};

function clamp(value: number, min: number, max: number) {
	if (min > max) return (min + max) / 2;
	return Math.min(Math.max(value, min), max);
}

function fontFamily(font: string) {
	if (font === "System Serif") return "serif";
	if (font === "System Monospace") return "monospace";
	return "system-ui, sans-serif";
}

function positionYFactor(position: string) {
	switch (position) {
		case "top-left":
		case "top-center":
		case "top":
		case "top-right":
			return 0.08;
		default:
			return 0.85;
	}
}

export function CaptionOverlay(props: CaptionOverlayProps) {
	const { project, setProject, editorState, setEditorState, projectHistory } =
		useEditorContext();
	const [measuredSize, setMeasuredSize] = createSignal({ width: 1, height: 1 });
	let hiddenMeasureRef: HTMLDivElement | undefined;

	const currentAbsoluteTime = () =>
		editorState.previewTime ?? editorState.playbackTime ?? 0;

	const settings = createMemo(() => ({
		...defaultCaptionSettings,
		...project.captions?.settings,
	}));

	const activeCaption = createMemo(() => {
		if (!settings().enabled) return null;
		const time = currentAbsoluteTime();
		const segments = project.timeline?.captionSegments ?? [];
		const index = segments.findIndex(
			(segment) => time >= segment.start && time < segment.end,
		);
		if (index < 0) return null;
		const segment = segments[index];
		if (!segment) return null;
		return { index, segment };
	});

	const text = createMemo(() => activeCaption()?.segment.text ?? "");

	const scaledFontSize = createMemo(() =>
		Math.max(settings().size * (props.size.height / 1080), 1),
	);

	const margin = createMemo(() => props.size.width * 0.05);
	const availableWidth = createMemo(() =>
		Math.max(props.size.width - margin() * 2, scaledFontSize()),
	);
	const fitScale = createMemo(() => {
		const padding = scaledFontSize() * 0.5;
		const measuredWidth = measuredSize().width + padding * 2;
		return measuredWidth > availableWidth()
			? Math.min(Math.max(availableWidth() / measuredWidth, 0.35), 1)
			: 1;
	});
	const effectiveFontSize = createMemo(() => scaledFontSize() * fitScale());

	createEffect(
		on(
			() =>
				[
					text(),
					scaledFontSize(),
					availableWidth(),
					settings().font,
					settings().fontWeight,
					fitScale(),
				] as const,
			() => {
				queueMicrotask(() => {
					requestAnimationFrame(() => {
						if (!hiddenMeasureRef) return;
						const measuredRect = hiddenMeasureRef.getBoundingClientRect();
						setMeasuredSize({
							width: Math.max(measuredRect.width, scaledFontSize()),
							height: Math.max(measuredRect.height, scaledFontSize() * 1.2),
						});
					});
				});
			},
		),
	);

	const rect = createMemo(() => {
		const padding = effectiveFontSize() * 0.5;
		const width = Math.min(
			measuredSize().width * fitScale() + padding * 2,
			availableWidth(),
		);
		const height = Math.min(
			measuredSize().height * fitScale() + padding * 2,
			Math.max(props.size.height, 1),
		);
		const currentSettings = settings();
		let left: number;
		let top: number;

		if (
			currentSettings.position === "manual" &&
			currentSettings.manualPosition
		) {
			left = clamp(
				currentSettings.manualPosition.x * props.size.width - width / 2,
				0,
				props.size.width - width,
			);
			top = clamp(
				currentSettings.manualPosition.y * props.size.height - height / 2,
				0,
				props.size.height - height,
			);
		} else {
			switch (currentSettings.position) {
				case "top-left":
				case "bottom-left":
					left = margin();
					break;
				case "top-right":
				case "bottom-right":
					left = props.size.width - margin() - width;
					break;
				default:
					left = (props.size.width - width) / 2;
					break;
			}

			top =
				props.size.height * positionYFactor(currentSettings.position) -
				height / 2;
			left = clamp(left, 0, props.size.width - width);
			top = clamp(top, 0, props.size.height - height);
		}

		return { left, top, width, height };
	});

	const selectedCaptionIndex = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "caption") return null;
		return selection.indices[0] ?? null;
	});

	const updateManualPosition = (position: { x: number; y: number }) => {
		if (!project.captions) return;

		setProject(
			"captions",
			"settings",
			produce((captionSettings) => {
				captionSettings.position = "manual";
				captionSettings.manualPosition = position;
			}),
		);
	};

	const createMouseDownDrag = (
		setup: () => {
			center: { x: number; y: number };
			rect: ReturnType<typeof rect>;
		},
		update: (
			event: MouseEvent,
			initial: {
				center: { x: number; y: number };
				rect: ReturnType<typeof rect>;
			},
			initialMouse: { x: number; y: number },
		) => void,
	) => {
		return (downEvent: MouseEvent) => {
			downEvent.preventDefault();
			downEvent.stopPropagation();

			const initial = setup();
			const initialMouse = { x: downEvent.clientX, y: downEvent.clientY };
			const resumeHistory = projectHistory.pause();

			function handleUpdate(event: MouseEvent) {
				update(event, initial, initialMouse);
			}

			const throttledUpdate = throttle(handleUpdate, 1000 / FPS);

			function finish(finalEvent: MouseEvent) {
				throttledUpdate.clear();
				handleUpdate(finalEvent);
				resumeHistory();
				dispose();
			}

			handleUpdate(downEvent);

			const dispose = createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: throttledUpdate,
					mouseup: finish,
				});
				return dispose;
			});
		};
	};

	const onMove = createMouseDownDrag(
		() => {
			const currentRect = rect();
			const currentSettings = settings();
			const center =
				currentSettings.position === "manual" && currentSettings.manualPosition
					? { ...currentSettings.manualPosition }
					: {
							x: (currentRect.left + currentRect.width / 2) / props.size.width,
							y: (currentRect.top + currentRect.height / 2) / props.size.height,
						};
			return { center, rect: currentRect };
		},
		(event, initial, initialMouse) => {
			if (props.size.width <= 0 || props.size.height <= 0) return;

			const dx = (event.clientX - initialMouse.x) / props.size.width;
			const dy = (event.clientY - initialMouse.y) / props.size.height;
			const halfWidth = initial.rect.width / props.size.width / 2;
			const halfHeight = initial.rect.height / props.size.height / 2;

			updateManualPosition({
				x: clamp(initial.center.x + dx, halfWidth, 1 - halfWidth),
				y: clamp(initial.center.y + dy, halfHeight, 1 - halfHeight),
			});
		},
	);

	const handleMouseDown = (
		caption: { index: number; segment: CaptionTrackSegment },
		event: MouseEvent,
	) => {
		setEditorState("timeline", "selection", {
			type: "caption",
			indices: [caption.index],
		});
		onMove(event);
	};

	return (
		<div class="absolute inset-0 pointer-events-none">
			<div
				ref={hiddenMeasureRef}
				class="absolute invisible pointer-events-none"
				style={{
					"white-space": "nowrap",
					"word-break": "break-word",
					"font-family": fontFamily(settings().font),
					"font-size": `${scaledFontSize()}px`,
					"font-weight": settings().fontWeight,
					"line-height": 1.2,
					"max-width": `${availableWidth()}px`,
					width: "fit-content",
					height: "auto",
					top: "0",
					left: "0",
				}}
			>
				{text()}
			</div>
			<Show when={activeCaption()}>
				{(caption) => (
					<div
						class="absolute pointer-events-auto rounded-md border-2 transition-colors"
						classList={{
							"border-blue-9 bg-blue-9/10 cursor-move":
								selectedCaptionIndex() === caption().index,
							"border-transparent hover:border-blue-6 hover:bg-blue-9/5":
								selectedCaptionIndex() !== caption().index,
						}}
						style={{
							left: `${rect().left}px`,
							top: `${rect().top}px`,
							width: `${rect().width}px`,
							height: `${rect().height}px`,
						}}
						onMouseDown={(event) => handleMouseDown(caption(), event)}
					/>
				)}
			</Show>
		</div>
	);
}
