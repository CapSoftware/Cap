import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import type {
	CheckMenuItemOptions,
	PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";
import { type as ostype } from "@tauri-apps/plugin-os";
import {
	type Accessor,
	children,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	type ParentProps,
	Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { createKeyDownSignal } from "~/utils/events";
import { MotionSafeTransition } from "~/utils/motion-safe";

import { commands } from "~/utils/tauri";
import { usePrefersReducedMotion } from "~/utils/use-media-query";
export interface CropBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
export const CROP_ZERO: CropBounds = { x: 0, y: 0, width: 0, height: 0 };

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type BoundsConstraints = {
	top: boolean;
	right: boolean;
	bottom: boolean;
	left: boolean;
};
type Vec2 = { x: number; y: number };

type HandleSide = {
	x: "l" | "r" | "c";
	y: "t" | "b" | "c";
	direction: Direction;
	cursor: string;
	movable: BoundsConstraints;
	origin: Vec2;
	isCorner: boolean;
};

const HANDLES: readonly HandleSide[] = [
	{ x: "l", y: "t", direction: "nw", cursor: "nwse-resize" },
	{ x: "r", y: "t", direction: "ne", cursor: "nesw-resize" },
	{ x: "l", y: "b", direction: "sw", cursor: "nesw-resize" },
	{ x: "r", y: "b", direction: "se", cursor: "nwse-resize" },
	{ x: "c", y: "t", direction: "n", cursor: "ns-resize" },
	{ x: "c", y: "b", direction: "s", cursor: "ns-resize" },
	{ x: "l", y: "c", direction: "w", cursor: "ew-resize" },
	{ x: "r", y: "c", direction: "e", cursor: "ew-resize" },
].map(
	(handle) =>
		({
			...handle,
			movable: {
				top: handle.y === "t",
				bottom: handle.y === "b",
				left: handle.x === "l",
				right: handle.x === "r",
			},
			origin: {
				x: handle.x === "l" ? 1 : handle.x === "r" ? 0 : 0.5,
				y: handle.y === "t" ? 1 : handle.y === "b" ? 0 : 0.5,
			},
			isCorner: handle.x !== "c" && handle.y !== "c",
		}) as HandleSide,
);
export type Ratio = [number, number];
export const COMMON_RATIOS: readonly Ratio[] = [
	[1, 1],
	[2, 1],
	[3, 2],
	[4, 3],
	[9, 16],
	[16, 9],
	[16, 10],
	[21, 9],
];
const ORIGIN_CENTER: Vec2 = { x: 0.5, y: 0.5 };

const ratioToValue = (r: Ratio) => r[0] / r[1];
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const easeInOutCubic = (t: number) =>
	t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const shouldTriggerHaptic = ostype() === "macos";
function triggerHaptic() {
	if (shouldTriggerHaptic) commands.performHapticFeedback("alignment", null);
}

function findClosestRatio(
	width: number,
	height: number,
	threshold = 0.01,
): Ratio | null {
	const currentRatio = width / height;
	for (const ratio of COMMON_RATIOS) {
		if (Math.abs(currentRatio - ratio[0] / ratio[1]) < threshold)
			return [ratio[0], ratio[1]];
		if (Math.abs(currentRatio - ratio[1] / ratio[0]) < threshold)
			return [ratio[1], ratio[0]];
	}
	return null;
}

// -----------------------------
// Bounds helpers
// -----------------------------
function moveBounds(
	bounds: CropBounds,
	x: number | null,
	y: number | null,
): CropBounds {
	return {
		...bounds,
		x: x !== null ? x : bounds.x,
		y: y !== null ? y : bounds.y,
	};
}

function resizeBounds(
	bounds: CropBounds,
	newWidth: number,
	newHeight: number,
	origin: Vec2,
): CropBounds {
	const fromX = bounds.x + bounds.width * origin.x;
	const fromY = bounds.y + bounds.height * origin.y;
	return {
		x: fromX - newWidth * origin.x,
		y: fromY - newHeight * origin.y,
		width: newWidth,
		height: newHeight,
	};
}

function scaleBounds(bounds: CropBounds, factor: number, origin: Vec2) {
	return resizeBounds(
		bounds,
		bounds.width * factor,
		bounds.height * factor,
		origin,
	);
}

function constrainBoundsToRatio(
	bounds: CropBounds,
	ratio: number,
	origin: Vec2,
) {
	const currentRatio = bounds.width / bounds.height;
	if (Math.abs(currentRatio - ratio) < 0.001) return bounds;
	return resizeBounds(bounds, bounds.width, bounds.width / ratio, origin);
}

function constrainBoundsToSize(
	bounds: CropBounds,
	max: Vec2 | null,
	min: Vec2 | null,
	origin: Vec2,
	ratio: number | null = null,
) {
	let next = { ...bounds };
	let maxW = max?.x ?? null;
	let maxH = max?.y ?? null;
	let minW = min?.x ?? null;
	let minH = min?.y ?? null;

	if (ratio) {
		// Correctly calculate effective min/max sizes when a ratio is present
		if (minW && minH) {
			const effectiveMinW = Math.max(minW, minH * ratio);
			minW = effectiveMinW;
			minH = effectiveMinW / ratio;
		}
		if (maxW && maxH) {
			const effectiveMaxW = Math.min(maxW, maxH * ratio);
			maxW = effectiveMaxW;
			maxH = effectiveMaxW / ratio;
		}
	}

	if (maxW && next.width > maxW)
		next = resizeBounds(next, maxW, ratio ? maxW / ratio : next.height, origin);
	if (maxH && next.height > maxH)
		next = resizeBounds(next, ratio ? maxH * ratio : next.width, maxH, origin);
	if (minW && next.width < minW)
		next = resizeBounds(next, minW, ratio ? minW / ratio : next.height, origin);
	if (minH && next.height < minH)
		next = resizeBounds(next, ratio ? minH * ratio : next.width, minH, origin);

	return next;
}

function slideBoundsIntoContainer(
	bounds: CropBounds,
	containerWidth: number,
	containerHeight: number,
): CropBounds {
	let { x, y, width, height } = bounds;

	if (x < 0) x = 0;
	if (y < 0) y = 0;
	if (x + width > containerWidth) x = containerWidth - width;
	if (y + height > containerHeight) y = containerHeight - height;

	return { ...bounds, x, y };
}

export type CropperRef = {
	fill: () => void;
	reset: () => void;
	setCropProperty: (field: keyof CropBounds, value: number) => void;
	setCrop: (
		value: CropBounds | ((b: CropBounds) => CropBounds),
		origin?: Vec2,
	) => void;
	bounds: Accessor<CropBounds>;
	animateTo: (real: CropBounds, durationMs?: number) => void;
};

export function Cropper(
	props: ParentProps<{
		onCropChange?: (bounds: CropBounds) => void;
		onInteraction?: (interacting: boolean) => void;
		onContextMenu?: (event: PointerEvent) => void;
		ref?: CropperRef | ((ref: CropperRef) => void);
		minSize?: Vec2;
		maxSize?: Vec2;
		targetSize?: Vec2;
		initialCrop?: CropBounds | (() => CropBounds | undefined);
		aspectRatio?: Ratio;
		showBounds?: boolean;
		snapToRatioEnabled?: boolean;
		useBackdropFilter?: boolean;
		allowLightMode?: boolean;
		enableAnimation?: boolean;
		onAnimationFrame?: (bounds: CropBounds) => void;
		hideSelection?: boolean;
	}>,
) {
	let containerRef: HTMLDivElement | undefined;
	let regionRef: HTMLDivElement | undefined;
	let occTopRef: HTMLDivElement | undefined;
	let occBottomRef: HTMLDivElement | undefined;
	let occLeftRef: HTMLDivElement | undefined;
	let occRightRef: HTMLDivElement | undefined;
	let plusRef: HTMLDivElement | undefined;

	const resolvedChildren = children(() => props.children);

	// raw bounds are in "logical" coordinates (not scaled to targetSize)
	const [rawBounds, setRawBounds] = createSignal<CropBounds>(CROP_ZERO);
	const [displayRawBounds, setDisplayRawBounds] =
		createSignal<CropBounds>(CROP_ZERO);

	const [isAnimating, setIsAnimating] = createSignal(false);
	let animationFrameId: number | null = null;
	const [isReady, setIsReady] = createSignal(false);

	function stopAnimation() {
		if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
		animationFrameId = null;
		setIsAnimating(false);
		setDisplayRawBounds(rawBounds());
	}

	const boundsTooSmall = createMemo(
		() => displayRawBounds().width <= 30 || displayRawBounds().height <= 30,
	);

	const [pointerState, setPointerState] = createStore<
		({ drag: null | "region" | "overlay" } | { drag: "handle" }) & {
			hoveringHandle: HandleSide | null;
			cursor: string | null;
		}
	>({ drag: null, hoveringHandle: null, cursor: null });

	const resizing = () =>
		pointerState.drag === "handle" || pointerState.drag === "overlay";

	const cursorStyle = () => {
		const drag = pointerState.drag;
		if (drag === "region") return "grabbing";
		if (drag === "handle" || drag === "overlay") return pointerState.cursor;
	};

	createEffect(() => props.onInteraction?.(pointerState.drag !== null));

	const [aspectState, setAspectState] = createStore({
		snapped: null as Ratio | null,
		value: null as number | null,
	});

	createEffect(() => {
		const min = props.minSize;
		const max = props.maxSize;

		if (min && max) {
			if (min.x > max.x)
				throw new Error(
					`Cropper constraint error: minSize.x (${min.x}px) exceeds maxSize.x (${max.x}px). Please adjust the size constraints.`,
				);
			if (min.y > max.y)
				throw new Error(
					`Cropper constraint error: minSize.y (${min.y}px) exceeds maxSize.y (${max.y}px). Please adjust the size constraints.`,
				);
		}
	});

	createEffect(
		on(
			() => props.aspectRatio,
			(v) => {
				const nextRatio = v ? ratioToValue(v) : null;
				setAspectState("value", nextRatio);

				if (!isReady() || !nextRatio) return;
				let targetBounds = rawBounds();

				targetBounds = constrainBoundsToRatio(
					targetBounds,
					nextRatio,
					ORIGIN_CENTER,
				);
				setRawBoundsAndAnimate(targetBounds);
			},
		),
	);

	const [containerSize, setContainerSize] = createSignal<Vec2>({ x: 1, y: 1 });
	const targetSize = createMemo(() => props.targetSize || containerSize());

	const logicalScale = createMemo<Vec2>(() => {
		if (props.targetSize) {
			const target = props.targetSize;
			const container = containerSize();
			return { x: target.x / container.x, y: target.y / container.y };
		}
		return { x: 1, y: 1 };
	});

	const realBounds = createMemo<CropBounds>(() => {
		const { x, y, width, height } = rawBounds();
		const scale = logicalScale();
		const target = targetSize();
		const bounds = {
			x: Math.round(x * scale.x),
			y: Math.round(y * scale.y),
			width: Math.round(width * scale.x),
			height: Math.round(height * scale.y),
		};

		if (bounds.width > target.x) bounds.width = target.x;
		if (bounds.height > target.y) bounds.height = target.y;
		if (bounds.x < 0) bounds.x = 0;
		if (bounds.y < 0) bounds.y = 0;
		if (bounds.x + bounds.width > target.x) bounds.x = target.x - bounds.width;
		if (bounds.y + bounds.height > target.y)
			bounds.y = target.y - bounds.height;

		props.onCropChange?.(bounds);
		return bounds;
	});

	function calculateLabelTransform(handle: HandleSide) {
		const bounds = rawBounds();
		if (!containerRef) return { x: 0, y: 0 };
		const containerRect = containerRef.getBoundingClientRect();
		const labelWidth = 80;
		const labelHeight = 25;
		const margin = 25;

		const handleScreenX =
			containerRect.left +
			bounds.x +
			bounds.width * (handle.x === "l" ? 0 : handle.x === "r" ? 1 : 0.5);
		const handleScreenY =
			containerRect.top +
			bounds.y +
			bounds.height * (handle.y === "t" ? 0 : handle.y === "b" ? 1 : 0.5);

		let idealX = handleScreenX;
		let idealY = handleScreenY;

		if (handle.x === "l") idealX -= labelWidth + margin;
		else if (handle.x === "r") idealX += margin;
		else idealX -= labelWidth / 2;

		if (handle.y === "t") idealY -= labelHeight + margin;
		else if (handle.y === "b") idealY += margin;
		else idealY -= labelHeight / 2;

		const finalX = clamp(
			idealX,
			margin,
			window.innerWidth - labelWidth - margin,
		);
		const finalY = clamp(
			idealY,
			margin,
			window.innerHeight - labelHeight - margin,
		);

		return { x: finalX, y: finalY };
	}

	const labelTransform = createMemo(() =>
		resizing() && pointerState.hoveringHandle
			? calculateLabelTransform(pointerState.hoveringHandle)
			: null,
	);

	function boundsToRaw(real: CropBounds) {
		const scale = logicalScale();
		return {
			x: Math.max(0, real.x / scale.x),
			y: Math.max(0, real.y / scale.y),
			width: Math.max(0, real.width / scale.x),
			height: Math.max(0, real.height / scale.y),
		};
	}

	const reducedMotion = usePrefersReducedMotion();

	function animateToRawBounds(target: CropBounds, durationMs = 240) {
		if (props.enableAnimation === false || reducedMotion()) {
			if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
			animationFrameId = null;
			setIsAnimating(false);
			setRawBounds(target);
			setDisplayRawBounds(target);
			return;
		}

		const start = displayRawBounds();
		if (
			target.x === start.x &&
			target.y === start.y &&
			target.width === start.width &&
			target.height === start.height
		) {
			animationFrameId = null;
			setIsAnimating(false);
			setDisplayRawBounds(target);
			return;
		}

		setIsAnimating(true);
		if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
		const startTime = performance.now();

		const step = () => {
			const now = performance.now();
			const t = Math.min(1, (now - startTime) / durationMs);
			const e = easeInOutCubic(t);
			setDisplayRawBounds({
				x: start.x + (target.x - start.x) * e,
				y: start.y + (target.y - start.y) * e,
				width: start.width + (target.width - start.width) * e,
				height: start.height + (target.height - start.height) * e,
			});
			if (t < 1) animationFrameId = requestAnimationFrame(step);
			else {
				animationFrameId = null;
				setIsAnimating(false);
				triggerHaptic();
			}
		};

		animationFrameId = requestAnimationFrame(step);
	}

	function setRawBoundsAndAnimate(
		bounds: CropBounds,
		origin?: Vec2,
		durationMs = 240,
	) {
		if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
		animationFrameId = null;
		setIsAnimating(true);
		setRawBoundsConstraining(bounds, origin);
		animateToRawBounds(rawBounds(), durationMs);
	}

	function computeInitialBounds(): CropBounds {
		const target = targetSize();
		const initialCrop =
			typeof props.initialCrop === "function"
				? props.initialCrop()
				: props.initialCrop;

		const startBoundsReal = initialCrop ?? {
			x: 0,
			y: 0,
			width: target.x / 2,
			height: target.y / 2,
		};

		let bounds = boundsToRaw(startBoundsReal);
		const ratioValue = aspectState.value;
		if (ratioValue)
			bounds = constrainBoundsToRatio(bounds, ratioValue, ORIGIN_CENTER);
		const container = containerSize();

		if (bounds.width > container.x)
			bounds = scaleBounds(bounds, container.x / bounds.width, ORIGIN_CENTER);
		if (bounds.height > container.y)
			bounds = scaleBounds(bounds, container.y / bounds.height, ORIGIN_CENTER);

		bounds = slideBoundsIntoContainer(bounds, container.x, container.y);

		if (!initialCrop)
			bounds = moveBounds(
				bounds,
				container.x / 2 - bounds.width / 2,
				container.y / 2 - bounds.height / 2,
			);
		return bounds;
	}

	function rawSizeConstraint() {
		const scale = logicalScale();
		return {
			min: props.minSize
				? { x: props.minSize.x / scale.x, y: props.minSize.y / scale.y }
				: null,
			max: props.maxSize
				? { x: props.maxSize.x / scale.x, y: props.maxSize.y / scale.y }
				: null,
		};
	}

	function setRawBoundsConstraining(
		bounds: CropBounds,
		origin = ORIGIN_CENTER,
	) {
		const ratioValue = aspectState.value;
		const container = containerSize();
		const { min, max } = rawSizeConstraint();
		let newBounds = { ...bounds };

		newBounds = constrainBoundsToSize(newBounds, max, min, origin, ratioValue);

		if (ratioValue)
			newBounds = constrainBoundsToRatio(newBounds, ratioValue, origin);

		if (newBounds.width > container.x)
			newBounds = scaleBounds(newBounds, container.x / newBounds.width, origin);
		if (newBounds.height > container.y)
			newBounds = scaleBounds(
				newBounds,
				container.y / newBounds.height,
				origin,
			);

		newBounds = slideBoundsIntoContainer(newBounds, container.x, container.y);
		setRawBounds(newBounds);
		if (!isAnimating()) setDisplayRawBounds(newBounds);
	}

	function fill() {
		const container = containerSize();
		const targetRaw = {
			x: 0,
			y: 0,
			width: container.x,
			height: container.y,
		};
		setRawBoundsAndAnimate(targetRaw);
		setAspectState("snapped", null);
	}

	onMount(() => {
		if (!containerRef) return;
		let initialized = false;

		const updateContainerSize = (width: number, height: number) => {
			const prevScale = logicalScale();
			const currentRaw = rawBounds();
			const preservedReal = {
				x: Math.round(currentRaw.x * prevScale.x),
				y: Math.round(currentRaw.y * prevScale.y),
				width: Math.round(currentRaw.width * prevScale.x),
				height: Math.round(currentRaw.height * prevScale.y),
			};

			setContainerSize({ x: width, y: height });

			// Only reconcile against previously-preserved bounds once we've
			// actually initialized — otherwise this clobbers rawBounds with a
			// constrained CROP_ZERO before init() has a chance to compute the
			// real starting crop, which is what caused the top-left flash.
			if (initialized) {
				setRawBoundsConstraining(boundsToRaw(preservedReal));
			}

			if (!initialized && width > 1 && height > 1) {
				initialized = true;
				init();
				setIsReady(true);
			}
		};

		createResizeObserver(containerRef, (e) =>
			updateContainerSize(e.width, e.height),
		);
		updateContainerSize(containerRef.clientWidth, containerRef.clientHeight);

		function init() {
			const bounds = computeInitialBounds();
			setRawBoundsConstraining(bounds);
			setDisplayRawBounds(bounds);
		}

		if (props.ref) {
			const cropperRef: CropperRef = {
				reset: () => {
					const bounds = computeInitialBounds();
					setRawBoundsAndAnimate(bounds);
					setAspectState("snapped", null);
				},
				fill,
				setCropProperty: (field, value) => {
					setAspectState("snapped", null);
					setRawBoundsConstraining(
						boundsToRaw({ ...realBounds(), [field]: value }),
						{ x: 0, y: 0 },
					);
				},
				setCrop: (value, origin) =>
					setRawBoundsConstraining(
						boundsToRaw(
							typeof value === "function" ? value(rawBounds()) : value,
						),
						origin,
					),
				get bounds() {
					return realBounds;
				},
				animateTo: (real, durationMs) =>
					setRawBoundsAndAnimate(boundsToRaw(real), undefined, durationMs),
			};

			if (typeof props.ref === "function") props.ref(cropperRef);
			else props.ref = cropperRef;
		}
	});

	function onRegionPointerDown(e: PointerEvent) {
		if (!containerRef || e.button !== 0) return;

		const target = e.currentTarget as HTMLElement;
		disposeActivePointerSession();
		stopAnimation();
		e.stopPropagation();
		setPointerState({ drag: "region" });
		let currentBounds = rawBounds();
		const containerRect = containerRef.getBoundingClientRect();
		const startOffset = {
			x: e.clientX - containerRect.left - currentBounds.x,
			y: e.clientY - containerRect.top - currentBounds.y,
		};

		trackPointerSession(
			target,
			e.pointerId,
			(e) => {
				let newX = e.clientX - containerRect.left - startOffset.x;
				let newY = e.clientY - containerRect.top - startOffset.y;

				newX = clamp(newX, 0, containerRect.width - currentBounds.width);
				newY = clamp(newY, 0, containerRect.height - currentBounds.height);

				currentBounds = moveBounds(currentBounds, newX, newY);
				setRawBounds(currentBounds);

				if (!isAnimating()) setDisplayRawBounds(currentBounds);
			},
			() => {
				setPointerState({ drag: null });
			},
		);
	}

	let activePointerSessionDispose: (() => void) | undefined;

	function disposeActivePointerSession() {
		activePointerSessionDispose?.();
		activePointerSessionDispose = undefined;
	}

	function trackPointerSession(
		target: HTMLElement,
		pointerId: number,
		onMove: (event: PointerEvent) => void,
		onEnd: () => void,
	) {
		target.setPointerCapture?.(pointerId);

		createRoot((dispose) => {
			let ended = false;
			const finish = () => {
				if (ended) return;
				ended = true;
				if (target.hasPointerCapture?.(pointerId)) {
					target.releasePointerCapture(pointerId);
				}
				onEnd();
				activePointerSessionDispose = undefined;
				dispose();
			};
			const finishForPointer = (event: PointerEvent) => {
				if (event.pointerId === pointerId) finish();
			};

			createEventListenerMap(window, {
				pointermove: (event) => {
					if (event.pointerId === pointerId) onMove(event);
				},
				pointerup: finishForPointer,
				pointercancel: finishForPointer,
				// While pointer capture is held the drag is still ours even if the window
				// loses focus (e.g. another overlay or the camera window grabs it on
				// Windows). Real pointer loss arrives via pointercancel/lostpointercapture.
				// Defer the capture check by one microtask so setPointerCapture has time
				// to finalize before we decide the session is orphaned.
				blur: () => {
					queueMicrotask(() => {
						if (!target.hasPointerCapture?.(pointerId)) finish();
					});
				},
			});
			createEventListenerMap(target, {
				lostpointercapture: finishForPointer,
			});

			activePointerSessionDispose = finish;
		});
	}

	onCleanup(() => {
		disposeActivePointerSession();
		if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
	});

	function liveHandleFromPointer(
		anchor: Vec2,
		pointX: number,
		pointY: number,
		original: HandleSide,
	): HandleSide {
		const left = pointX < anchor.x;
		const top = pointY < anchor.y;

		if (original.isCorner) {
			return (
				HANDLES.find(
					(h) => h.isCorner && (h.x === "l") === left && (h.y === "t") === top,
				) ?? original
			);
		}
		// Side handles only flip along their own axis, and must stay a side
		// (y === "c" for horizontal, x === "c" for vertical) — otherwise this
		// matches a corner that happens to share the same x/y label.
		if (original.x !== "c") {
			return (
				HANDLES.find((h) => h.y === "c" && (h.x === "l") === left) ?? original
			);
		}
		if (original.y !== "c") {
			return (
				HANDLES.find((h) => h.x === "c" && (h.y === "t") === top) ?? original
			);
		}
		return original;
	}

	function onHandlePointerDown(handle: HandleSide, e: PointerEvent) {
		if (!containerRef || e.button !== 0) return;
		const target = e.currentTarget as HTMLElement;
		disposeActivePointerSession();
		e.stopPropagation();

		stopAnimation();
		setPointerState({ drag: "handle", cursor: handle.cursor });

		const context: ResizeSessionState = {
			containerRect: containerRef.getBoundingClientRect(),
			startBounds: rawBounds(),
			isAltMode: e.altKey,
			activeHandle: { ...handle },
			originalHandle: handle,
		};

		trackPointerSession(
			target,
			e.pointerId,
			(e) => handleResizePointerMove(e, context),
			() => {
				setPointerState({ drag: null });
			},
		);
	}

	// Helper: update handle movable sides when switching between anchor <-> center-origin mode
	function updateHandleForModeSwitch(
		handle: HandleSide,
		currentBounds: CropBounds,
		pointX: number,
		pointY: number,
	) {
		const center = {
			x: currentBounds.x + currentBounds.width / 2,
			y: currentBounds.y + currentBounds.height / 2,
		};
		const newMovable = { ...handle.movable };
		if (handle.movable.left || handle.movable.right) {
			newMovable.left = pointX < center.x;
			newMovable.right = pointX >= center.x;
		}
		if (handle.movable.top || handle.movable.bottom) {
			newMovable.top = pointY < center.y;
			newMovable.bottom = pointY >= center.y;
		}
		return { ...handle, movable: newMovable };
	}

	type ResizeSessionState = {
		startBounds: CropBounds;
		isAltMode: boolean;
		activeHandle: HandleSide;
		originalHandle: HandleSide;
		containerRect: DOMRect;
	};

	function handleResizePointerMove(
		e: PointerEvent,
		context: ResizeSessionState,
	) {
		const pointX = e.clientX - context.containerRect.left;
		const pointY = e.clientY - context.containerRect.top;

		if (e.altKey !== context.isAltMode) {
			context.isAltMode = e.altKey;
			context.startBounds = rawBounds();
			if (context.isAltMode) {
				context.activeHandle = context.originalHandle;
			} else {
				context.activeHandle = updateHandleForModeSwitch(
					context.originalHandle,
					context.startBounds,
					pointX,
					pointY,
				);
			}
		}

		const anchor = context.isAltMode
			? {
					x: context.startBounds.x + context.startBounds.width / 2,
					y: context.startBounds.y + context.startBounds.height / 2,
				}
			: {
					x:
						context.startBounds.x +
						(context.originalHandle.movable.left
							? context.startBounds.width
							: 0),
					y:
						context.startBounds.y +
						(context.originalHandle.movable.top
							? context.startBounds.height
							: 0),
				};

		const live = liveHandleFromPointer(
			anchor,
			pointX,
			pointY,
			context.originalHandle,
		);
		if (pointerState.hoveringHandle !== live) {
			// Always clone to avoid possibly mutating the state directly.
			// Without cloning, the handles can become mutated and break the functionality.
			setPointerState("hoveringHandle", { ...live });
		}

		const { min, max } = rawSizeConstraint();
		const shiftKey = e.shiftKey;
		const ratioValue = aspectState.value;

		const options: ResizeOptions = {
			container: containerSize(),
			min,
			max,
			isAltMode: context.isAltMode,
			shiftKey,
			ratioValue,
			snapToRatioEnabled: !!props.snapToRatioEnabled && !boundsTooSmall(),
		};

		let nextBounds: CropBounds;

		if (ratioValue !== null) {
			nextBounds =
				computeAspectRatioResize(
					pointX,
					pointY,
					context.startBounds,
					context.activeHandle,
					options,
				) ?? rawBounds();
		} else {
			const { bounds, snappedRatio } = computeFreeResize(
				pointX,
				pointY,
				context.startBounds,
				context.activeHandle,
				options,
			);
			nextBounds = bounds;
			if (snappedRatio && !aspectState.snapped) {
				triggerHaptic();
			}
			setAspectState("snapped", snappedRatio);
		}

		const finalBounds = slideBoundsIntoContainer(
			nextBounds,
			containerSize().x,
			containerSize().y,
		);

		setRawBounds(finalBounds);
		if (!isAnimating()) setDisplayRawBounds(finalBounds);
	}

	function onHandleDoubleClick(handle: HandleSide, e: MouseEvent) {
		e.stopPropagation();
		const currentBounds = rawBounds();
		const container = containerSize();

		const newBounds = { ...currentBounds };

		if (handle.movable.top) {
			newBounds.height = currentBounds.y + currentBounds.height;
			newBounds.y = 0;
		}
		if (handle.movable.bottom) {
			newBounds.height = container.y - currentBounds.y;
		}
		if (handle.movable.left) {
			newBounds.width = currentBounds.x + currentBounds.width;
			newBounds.x = 0;
		}
		if (handle.movable.right) {
			newBounds.width = container.x - currentBounds.x;
		}

		setRawBoundsAndAnimate(newBounds, handle.origin);
	}

	function onOverlayPointerDown(e: PointerEvent) {
		if (!containerRef || e.button !== 0) return;
		const target = e.currentTarget as HTMLElement;
		disposeActivePointerSession();
		e.preventDefault();
		e.stopPropagation();
		stopAnimation();

		const initialBounds = { ...rawBounds() };
		const SE_HANDLE_INDEX = 3; // use bottom-right as the temporary handle
		const handle = HANDLES[SE_HANDLE_INDEX];

		setPointerState({ drag: "overlay", cursor: "crosshair" });

		const containerRect = containerRef.getBoundingClientRect();
		const startPoint = {
			x: e.clientX - containerRect.left,
			y: e.clientY - containerRect.top,
		};

		const startBounds: CropBounds = {
			x: startPoint.x,
			y: startPoint.y,
			width: 1,
			height: 1,
		};

		const context: ResizeSessionState = {
			containerRect,
			startBounds,
			isAltMode: e.altKey,
			activeHandle: { ...handle },
			originalHandle: handle,
		};

		trackPointerSession(
			target,
			e.pointerId,
			(e) => handleResizePointerMove(e, context),
			() => {
				setPointerState({ drag: null, cursor: null });
				const bounds = rawBounds();
				if (bounds.width < 5 || bounds.height < 5) {
					setRawBounds(initialBounds);
					if (!isAnimating()) setDisplayRawBounds(initialBounds);
				}
			},
		);
	}

	const KEY_MAPPINGS = new Map([
		["ArrowRight", "e"],
		["ArrowDown", "s"],
		["ArrowLeft", "w"],
		["ArrowUp", "n"],
	]);

	const [keyboardState, setKeyboardState] = createStore({
		pressedKeys: new Set<string>(),
		shift: false,
		alt: false,
		meta: false, // Cmd or Ctrl
	});

	let keyboardFrameId: number | null = null;

	function keyboardActionLoop() {
		const currentBounds = rawBounds();
		const { pressedKeys, shift, alt, meta } = keyboardState;

		const delta = shift ? 10 : 2;

		if (meta) {
			// Resize
			const origin = alt ? ORIGIN_CENTER : { x: 0, y: 0 };
			let newWidth = currentBounds.width;
			let newHeight = currentBounds.height;

			if (pressedKeys.has("ArrowLeft")) newWidth -= delta;
			if (pressedKeys.has("ArrowRight")) newWidth += delta;
			if (pressedKeys.has("ArrowUp")) newHeight -= delta;
			if (pressedKeys.has("ArrowDown")) newHeight += delta;

			newWidth = Math.max(1, newWidth);
			newHeight = Math.max(1, newHeight);

			const resized = resizeBounds(currentBounds, newWidth, newHeight, origin);

			setRawBoundsConstraining(resized, origin);
		} else {
			// Move
			let dx = 0;
			let dy = 0;

			if (pressedKeys.has("ArrowLeft")) dx -= delta;
			if (pressedKeys.has("ArrowRight")) dx += delta;
			if (pressedKeys.has("ArrowUp")) dy -= delta;
			if (pressedKeys.has("ArrowDown")) dy += delta;

			const moved = moveBounds(
				currentBounds,
				currentBounds.x + dx,
				currentBounds.y + dy,
			);

			setRawBoundsConstraining(moved);
		}

		keyboardFrameId = requestAnimationFrame(keyboardActionLoop);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (!KEY_MAPPINGS.has(e.key) || pointerState.drag !== null) return;

		e.preventDefault();
		e.stopPropagation();

		setKeyboardState("pressedKeys", (p) => p.add(e.key));
		setKeyboardState({
			shift: e.shiftKey,
			alt: e.altKey,
			meta: e.metaKey || e.ctrlKey,
		});

		if (!keyboardFrameId) {
			stopAnimation();
			keyboardActionLoop();
		}
	}

	function handleKeyUp(e: KeyboardEvent) {
		if (
			!KEY_MAPPINGS.has(e.key) &&
			!["Shift", "Alt", "Meta", "Control"].includes(e.key)
		)
			return;

		e.preventDefault();

		setKeyboardState("pressedKeys", (p) => {
			p.delete(e.key);
			return p;
		});

		setKeyboardState({
			shift: e.shiftKey,
			alt: e.altKey,
			meta: e.metaKey || e.ctrlKey,
		});

		if (keyboardState.pressedKeys.size === 0) {
			if (keyboardFrameId) {
				cancelAnimationFrame(keyboardFrameId);
				keyboardFrameId = null;
			}
		}
	}

	// Only update during a frame animation.
	// Note: Doing this any other way can very likely cause a huge memory usage or even leak until the resizing stops.
	createEffect(
		on<CropBounds, number>(displayRawBounds, (b, _prevIn, prevFrameId) => {
			if (prevFrameId) cancelAnimationFrame(prevFrameId);
			return requestAnimationFrame(() => {
				if (!isReady()) return;
				const x = Math.round(b.x);
				const y = Math.round(b.y);
				const right = Math.round(b.x + b.width);
				const bottom = Math.round(b.y + b.height);
				const width = right - x;
				const height = bottom - y;

				if (regionRef) {
					regionRef.style.width = `${width}px`;
					regionRef.style.height = `${height}px`;
					regionRef.style.transform = `translate(${x}px,${y}px)`;
				}
				if (occLeftRef) {
					occLeftRef.style.width = `${Math.max(0, x)}px`;
				}
				if (occRightRef) {
					occRightRef.style.left = `${right}px`;
				}
				if (occTopRef) {
					occTopRef.style.left = `${x}px`;
					occTopRef.style.width = `${width}px`;
					occTopRef.style.height = `${Math.max(0, y)}px`;
				}
				if (occBottomRef) {
					occBottomRef.style.top = `${bottom}px`;
					occBottomRef.style.left = `${x}px`;
					occBottomRef.style.width = `${width}px`;
				}
				if (plusRef) {
					const w = Math.round(b.x + b.width) - Math.round(b.x);
					const h = Math.round(b.y + b.height) - Math.round(b.y);
					plusRef.style.transform = `translate(${Math.round(w / 2) - 2}px,${Math.round(h / 2) - 2}px) translate(-50%,-50%)`;
				}
				props.onAnimationFrame?.({ x, y, width, height });
			});
		}),
	);

	const altDown = createKeyDownSignal(window, "Alt");

	return (
		<div
			ref={containerRef}
			class="relative w-full h-full select-none overscroll-contain focus:outline-hidden touch-none"
			style={{
				cursor: cursorStyle() ?? (props.aspectRatio ? "default" : "crosshair"),
			}}
			onKeyDown={handleKeyDown}
			onKeyUp={handleKeyUp}
			tabIndex={0}
			onContextMenu={props.onContextMenu}
			onDblClick={() => fill()}
		>
			<MotionSafeTransition
				appear
				enterActiveClass="transition-opacity duration-300 ease-in-out"
				enterClass="opacity-0 blur-xs"
				enterToClass="opacity-100 blur-none"
				exitActiveClass="transition-opacity duration-300 ease-in-out"
				exitClass="opacity-100 blur-none"
				exitToClass="opacity-0 blur-xs"
			>
				<Show when={props.showBounds && labelTransform()}>
					{(transform) => (
						<div
							class="fixed z-50 pointer-events-none bg-gray-2 text-xs px-2 py-0.5 rounded-full shadow-lg border border-gray-5 font-mono"
							style={{
								transform: `translate(${transform().x}px, ${transform().y}px)`,
							}}
						>
							{realBounds().width} x {realBounds().height}
						</div>
					)}
				</Show>
			</MotionSafeTransition>

			{resolvedChildren()}

			{/* Occluder */}
			<div
				class="absolute inset-0 *:absolute *:bg-black/45 *:pointer-events-none"
				aria-hidden="true"
			>
				<div ref={occLeftRef} class="top-0 left-0 h-full" />
				<div ref={occRightRef} class="top-0 right-0 h-full" />
				<div ref={occTopRef} class="top-0" />
				<div ref={occBottomRef} class="bottom-0" />
			</div>

			{/* Crop region container */}
			<div class="size-full">
				<div
					ref={regionRef}
					class="absolute top-0 left-0 z-30 border-2 border-white/50 contrast-more:border-white contrast-more:shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
					style={{
						cursor: cursorStyle() ?? "grab",
						visibility:
							isReady() && !props.hideSelection ? "visible" : "hidden",
					}}
					onDblClick={(e) => e.stopPropagation()}
				>
					<button
						class="absolute inset-0 z-10 bg-transparent"
						type="button"
						tabIndex={-1}
						style={{ cursor: cursorStyle() ?? "grab" }}
						onPointerDown={onRegionPointerDown}
					/>

					<Show when={altDown() && !boundsTooSmall()}>
						<div
							ref={(el) => {
								plusRef = el;
								const b = displayRawBounds();
								const w = Math.round(b.x + b.width) - Math.round(b.x);
								const h = Math.round(b.y + b.height) - Math.round(b.y);
								el.style.transform = `translate(${Math.round(w / 2) - 1}px,${Math.round(h / 2) - 1}px) translate(-50%,-50%)`;
							}}
							class="absolute top-0 left-0 opacity-70 pointer-events-none"
						>
							<IconLucidePlus class="pointer-events-none size-6" />
						</div>
					</Show>

					<MotionSafeTransition
						appear
						enterActiveClass="transition-opacity duration-300"
						enterClass="opacity-0"
						enterToClass="opacity-100"
						exitActiveClass="transition-opacity duration-300"
						exitClass="opacity-100"
						exitToClass="opacity-0"
					>
						<Show when={pointerState.drag !== null}>
							<div class="pointer-events-none *:absolute *:border-white/40">
								<div class="left-0 w-full border-t border-b pointer-events-none h-[calc(100%/3)] top-[calc(100%/3)]" />
								<div class="top-0 h-full border-l border-r pointer-events-none w-[calc(100%/3)] left-[calc(100%/3)]" />
							</div>
						</Show>
					</MotionSafeTransition>

					<For each={HANDLES}>
						{(handle) =>
							handle.isCorner ? (
								<button
									type="button"
									class="fixed z-50 flex h-[30px] w-[30px] focus:ring-0 outline-hidden"
									tabIndex={-1}
									classList={{ "opacity-0": pointerState.drag === "overlay" }}
									style={{
										cursor:
											pointerState.drag === "handle" &&
											pointerState.hoveringHandle?.isCorner
												? pointerState.hoveringHandle.cursor
												: (cursorStyle() ?? handle.cursor),
										...(handle.x === "l"
											? { left: "-12px" }
											: { right: "-12px" }),
										...(handle.y === "t"
											? { top: "-12px" }
											: { bottom: "-12px" }),
									}}
									onMouseEnter={() =>
										setPointerState("hoveringHandle", { ...handle })
									}
									onDblClick={[onHandleDoubleClick, handle]}
									onPointerDown={[onHandlePointerDown, handle]}
									aria-label={`Resize ${handle.direction}`}
									aria-describedby="cropper-aspect"
								>
									<svg
										aria-hidden="true"
										class="absolute pointer-events-none drop-shadow-xs shadow-black"
										classList={{
											"size-1": boundsTooSmall(),
											"size-6": !boundsTooSmall(),
										}}
										viewBox="0 0 16 16"
										fill="none"
										stroke="white"
										stroke-width="4"
										stroke-linecap="square"
										style={{
											...(handle.x === "l"
												? { left: "9px" }
												: { right: "9px" }),
											...(handle.y === "t"
												? { top: "9px" }
												: { bottom: "9px" }),
											filter: `drop-shadow(${handle.x === "l" ? "-3px" : "3px"} ${handle.y === "t" ? "-3px" : "3px"} 5px rgba(0, 0, 0, 0.3))`,
										}}
									>
										<path
											d={
												handle.x === "l" && handle.y === "t"
													? "M0 0 H12 M0 0 V12"
													: handle.x === "r" && handle.y === "t"
														? "M16 0 H4 M16 0 V12"
														: handle.x === "r" && handle.y === "b"
															? "M16 16 H4 M16 16 V4"
															: "M0 16 H12 M0 16 V4"
											}
										/>
									</svg>
								</button>
							) : (
								<button
									type="button"
									class="absolute focus:outline-hidden focus:ring-0 outline-hidden"
									tabIndex={-1}
									style={{
										visibility:
											resizing() && pointerState.hoveringHandle?.isCorner
												? "hidden"
												: "visible",
										cursor: cursorStyle() ?? handle.cursor,
										...(handle.x === "l"
											? {
													left: "-1px",
													width: "10px",
													top: "10px",
													bottom: "10px",
													transform: "translateX(-50%)",
												}
											: handle.x === "r"
												? {
														right: "-1px",
														width: "10px",
														top: "10px",
														bottom: "10px",
														transform: "translateX(50%)",
													}
												: handle.y === "t"
													? {
															top: "-1px",
															height: "10px",
															left: "10px",
															right: "10px",
															transform: "translateY(-50%)",
														}
													: {
															bottom: "-1px",
															height: "10px",
															left: "10px",
															right: "10px",
															transform: "translateY(50%)",
														}),
									}}
									onMouseEnter={() =>
										setPointerState("hoveringHandle", { ...handle })
									}
									onDblClick={[onHandleDoubleClick, handle]}
									onPointerDown={[onHandlePointerDown, handle]}
									aria-label={`Resize ${handle.direction}`}
									aria-describedby="cropper-aspect"
								/>
							)
						}
					</For>

					<Show
						when={
							!props.aspectRatio && !boundsTooSmall()
								? aspectState.snapped
								: null
						}
						keyed
					>
						{(bounds) => (
							<div
								class="w-full h-8 flex items-center justify-center"
								id="cropper-aspect"
								aria-live="polite"
							>
								<div
									class="h-[18px] w-11 rounded-full text-center text-xs text-gray-12 border border-white/70 dark:border-white/20 contrast-more:bg-gray-1! drop-shadow-md outline-1 outline-solid outline-black/80"
									classList={{
										"backdrop-blur-xs bg-white/50 dark:bg-black/50 dark:backdrop-brightness-90 backdrop-brightness-200":
											props.useBackdropFilter,
										"bg-gray-3 not-contrast-more:opacity-80":
											!props.useBackdropFilter,
									}}
								>
									{bounds[0]}:{bounds[1]}
								</div>
							</div>
						)}
					</Show>
				</div>

				<button
					type="button"
					class="absolute inset-0 z-20 bg-transparent p-0 m-0 border-0"
					aria-label="Start selection"
					onPointerDown={onOverlayPointerDown}
					style={{ cursor: cursorStyle() ?? "crosshair" }}
				/>
			</div>
		</div>
	);
}

type ResizeOptions = {
	container: Vec2;
	min: Vec2 | null;
	max: Vec2 | null;
	isAltMode: boolean;
	shiftKey: boolean;
	ratioValue: number | null;
	snapToRatioEnabled: boolean;
};

function computeAspectRatioResize(
	pointX: number,
	pointY: number,
	startBounds: CropBounds,
	handle: HandleSide,
	options: ResizeOptions,
): CropBounds | null {
	const { container, min, max, ratioValue } = options;
	if (ratioValue === null) return startBounds;

	// Determine the stationary anchor point.
	const anchorX = startBounds.x + (handle.movable.left ? startBounds.width : 0);
	const anchorY = startBounds.y + (handle.movable.top ? startBounds.height : 0);

	// Calculate raw dimensions from anchor to the clamped mouse position
	const mX = clamp(pointX, 0, container.x);
	const mY = clamp(pointY, 0, container.y);
	const rawWidth = Math.abs(mX - anchorX);
	const rawHeight = Math.abs(mY - anchorY);

	// Determine the "ideal" size by respecting the aspect ratio based on the dominant mouse movement
	let targetW: number;
	let targetH: number;

	if (handle.isCorner) {
		// For corners, let the dominant mouse direction drive the aspect ratio
		if (rawWidth / ratioValue > rawHeight) {
			targetW = rawWidth;
			targetH = targetW / ratioValue;
		} else {
			targetH = rawHeight;
			targetW = targetH * ratioValue;
		}
	} else if (handle.x !== "c") {
		targetW = rawWidth;
		targetH = targetW / ratioValue;
	} else {
		targetH = rawHeight;
		targetW = targetH * ratioValue;
	}

	const newX = mX < anchorX ? anchorX - targetW : anchorX;
	const newY = mY < anchorY ? anchorY - targetH : anchorY;
	let finalBounds = { x: newX, y: newY, width: targetW, height: targetH };

	if (
		finalBounds.x < 0 ||
		finalBounds.y < 0 ||
		finalBounds.x + finalBounds.width > container.x ||
		finalBounds.y + finalBounds.height > container.y
	) {
		return null;
	}

	const resizeOrigin = { x: mX < anchorX ? 1 : 0, y: mY < anchorY ? 1 : 0 };
	finalBounds = constrainBoundsToSize(
		finalBounds,
		max,
		min,
		resizeOrigin,
		ratioValue,
	);

	if (finalBounds.width > container.x) {
		const scale = container.x / finalBounds.width;
		finalBounds.width = container.x;
		finalBounds.height *= scale;
	}
	if (finalBounds.height > container.y) {
		const scale = container.y / finalBounds.height;
		finalBounds.height = container.y;
		finalBounds.width *= scale;
	}

	finalBounds = slideBoundsIntoContainer(finalBounds, container.x, container.y);

	return {
		x: finalBounds.x,
		y: finalBounds.y,
		width: Math.max(1, finalBounds.width),
		height: Math.max(1, finalBounds.height),
	};
}

function computeFreeResize(
	pointX: number,
	pointY: number,
	startBounds: CropBounds,
	handle: HandleSide,
	options: ResizeOptions,
): { bounds: CropBounds; snappedRatio: Ratio | null } {
	const { container, min, max, isAltMode, shiftKey, snapToRatioEnabled } =
		options;
	let snappedRatio: Ratio | null = null;

	let bounds: CropBounds;

	if (isAltMode) {
		const center = {
			x: startBounds.x + startBounds.width / 2,
			y: startBounds.y + startBounds.height / 2,
		};

		const distW = Math.abs(pointX - center.x);
		const distH = Math.abs(pointY - center.y);

		const expLeft = Math.min(distW, center.x);
		const expRight = Math.min(distW, container.x - center.x);
		const expTop = Math.min(distH, center.y);
		const expBottom = Math.min(distH, container.y - center.y);

		const changesX = handle.movable.left || handle.movable.right;
		const changesY = handle.movable.top || handle.movable.bottom;

		let newW = changesX ? expLeft + expRight : startBounds.width;
		let newH = changesY ? expTop + expBottom : startBounds.height;

		if (min) {
			newW = Math.max(newW, min.x);
			newH = Math.max(newH, min.y);
		}
		if (max) {
			newW = Math.min(newW, max.x);
			newH = Math.min(newH, max.y);
		}

		if (!shiftKey && handle.isCorner && snapToRatioEnabled) {
			const closest = findClosestRatio(newW, newH);
			if (closest) {
				const r = ratioToValue(closest);
				if (handle.movable.top || handle.movable.bottom) newW = newH * r;
				else newH = newW / r;
				snappedRatio = closest;
			}
		}

		bounds = {
			x: center.x - newW / 2,
			y: center.y - newH / 2,
			width: newW,
			height: newH,
		};
	} else {
		const anchor = {
			x: startBounds.x + (handle.movable.left ? startBounds.width : 0),
			y: startBounds.y + (handle.movable.top ? startBounds.height : 0),
		};
		const clampedX = clamp(pointX, 0, container.x);
		const clampedY = clamp(pointY, 0, container.y);

		let x1 =
			handle.movable.left || handle.movable.right ? clampedX : startBounds.x;
		let y1 =
			handle.movable.top || handle.movable.bottom ? clampedY : startBounds.y;
		let x2 = anchor.x;
		let y2 = anchor.y;

		if (!handle.movable.left && !handle.movable.right) {
			x1 = startBounds.x;
			x2 = startBounds.x + startBounds.width;
		}
		if (!handle.movable.top && !handle.movable.bottom) {
			y1 = startBounds.y;
			y2 = startBounds.y + startBounds.height;
		}

		let newX = Math.min(x1, x2);
		let newY = Math.min(y1, y2);
		let newW = Math.abs(x1 - x2);
		let newH = Math.abs(y1 - y2);

		if (min) {
			if (newW < min.x) {
				const diff = min.x - newW;
				newW = min.x;
				if (clampedX < anchor.x) newX -= diff;
			}
			if (newH < min.y) {
				const diff = min.y - newH;
				newH = min.y;
				if (clampedY < anchor.y) newY -= diff;
			}
		}
		if (max) {
			if (newW > max.x) {
				const diff = newW - max.x;
				newW = max.x;
				if (clampedX < anchor.x) newX += diff;
			}
			if (newH > max.y) {
				const diff = newH - max.y;
				newH = max.y;
				if (clampedY < anchor.y) newY += diff;
			}
		}

		if (!shiftKey && handle.isCorner && snapToRatioEnabled) {
			const closest = findClosestRatio(newW, newH);
			if (closest) {
				const r = ratioToValue(closest);
				if (handle.movable.top || handle.movable.bottom) newW = newH * r;
				else newH = newW / r;
				if (clampedX < anchor.x) newX = anchor.x - newW;
				if (clampedY < anchor.y) newY = anchor.y - newH;
				snappedRatio = closest;
			}
		}

		bounds = {
			x: newX,
			y: newY,
			width: newW,
			height: newH,
		};
	}
	return { bounds, snappedRatio };
}

export function createCropOptionsMenuItems(options: {
	aspect: Ratio | null;
	snapToRatioEnabled: boolean;
	onAspectSet: (aspect: Ratio | null) => void;
	onSnapToRatioSet: (enabled: boolean) => void;
}) {
	return [
		{
			text: "Free",
			checked: !options.aspect,
			action: () => options.onAspectSet(null),
		} satisfies CheckMenuItemOptions,
		...COMMON_RATIOS.map(
			(ratio) =>
				({
					text: `${ratio[0]}:${ratio[1]}`,
					checked:
						options.aspect?.[0] === ratio[0] && options.aspect[1] === ratio[1],
					action: () => options.onAspectSet(ratio),
				}) satisfies CheckMenuItemOptions,
		),
		{ item: "Separator" } satisfies PredefinedMenuItemOptions,
		{
			text: "Snap to ratios",
			checked: options.snapToRatioEnabled,
			action: () => options.onSnapToRatioSet(!options.snapToRatioEnabled),
		} satisfies CheckMenuItemOptions,
	];
}
