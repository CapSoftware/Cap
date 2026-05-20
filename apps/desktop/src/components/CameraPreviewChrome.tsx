import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { BackgroundBlurMode, CameraPreviewShape } from "~/utils/tauri";

export type CameraWindowState = {
	size: number;
	shape: CameraPreviewShape;
	mirrored: boolean;
	backgroundBlur: BackgroundBlurMode | boolean;
};

export const CAMERA_MIN_SIZE = 150;
export const CAMERA_MAX_SIZE = 600;
export const CAMERA_DEFAULT_SIZE = 230;
export const CAMERA_PRESET_SMALL = 230;
export const CAMERA_PRESET_LARGE = 400;
export const CAMERA_TOOLBAR_HEIGHT = 56;
export const CAMERA_WINDOW_STATE_STORAGE_KEY = "cameraWindowState";

const BLUR_MODES: BackgroundBlurMode[] = ["off", "light", "heavy"];
const RESIZE_CORNERS = ["nw", "ne", "sw", "se"] as const;

type ResizeCorner = (typeof RESIZE_CORNERS)[number];

export const getDefaultCameraWindowState = (): CameraWindowState => ({
	size: CAMERA_DEFAULT_SIZE,
	shape: "round",
	mirrored: false,
	backgroundBlur: "off",
});

export const clampCameraSize = (size: number) =>
	Math.max(CAMERA_MIN_SIZE, Math.min(CAMERA_MAX_SIZE, size));

export const normalizeBackgroundBlurMode = (
	mode: BackgroundBlurMode | boolean | undefined,
): BackgroundBlurMode => {
	if (typeof mode === "boolean") return mode ? "heavy" : "off";
	return mode ?? "off";
};

export const cycleBlurMode = (
	current: BackgroundBlurMode | boolean,
): BackgroundBlurMode => {
	if (typeof current === "boolean") {
		return current ? "heavy" : "light";
	}
	const idx = BLUR_MODES.indexOf(current);
	return BLUR_MODES[(idx + 1) % BLUR_MODES.length];
};

export const blurModeLabel = (mode: BackgroundBlurMode | boolean): string => {
	if (typeof mode === "boolean") return mode ? "Blur" : "";
	switch (mode) {
		case "light":
			return "Light";
		case "heavy":
			return "Heavy";
		default:
			return "";
	}
};

export const cameraToolbarScale = (size: number) => {
	const normalized =
		(clampCameraSize(size) - CAMERA_MIN_SIZE) /
		(CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
	return 0.7 + normalized * 0.3;
};

export function cameraBorderRadius(state: CameraWindowState) {
	if (state.shape === "round") return "9999px";
	const normalized =
		(clampCameraSize(state.size) - CAMERA_MIN_SIZE) /
		(CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
	const radius = 3 + normalized * 1.5;
	return `${radius}rem`;
}

export function CameraPreviewToolbar(props: {
	state: CameraWindowState;
	setState: SetStoreFunction<CameraWindowState>;
	visible: boolean;
	scale?: number;
	onClose?: () => void;
}) {
	const toolbarClass = () =>
		cx(
			"flex flex-row gap-1 p-1 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10",
			props.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
		);

	return (
		<div
			class={toolbarClass()}
			style={{ transform: `scale(${props.scale ?? 1})` }}
		>
			<Show when={props.onClose}>
				{(onClose) => (
					<ControlButton onClick={onClose()}>
						<IconCapCircleX class="size-5.5" />
					</ControlButton>
				)}
			</Show>
			<ControlButton
				pressed={props.state.size >= CAMERA_PRESET_LARGE}
				onClick={() => {
					props.setState(
						"size",
						props.state.size < CAMERA_PRESET_LARGE
							? CAMERA_PRESET_LARGE
							: CAMERA_PRESET_SMALL,
					);
				}}
			>
				<IconCapEnlarge class="size-5.5" />
			</ControlButton>
			<ControlButton
				pressed={props.state.shape !== "round"}
				onClick={() =>
					props.setState("shape", (shape) =>
						shape === "round"
							? "square"
							: shape === "square"
								? "full"
								: "round",
					)
				}
			>
				{props.state.shape === "round" && <IconCapCircle class="size-5.5" />}
				{props.state.shape === "square" && <IconCapSquare class="size-5.5" />}
				{props.state.shape === "full" && (
					<IconLucideRectangleHorizontal class="size-5.5" />
				)}
			</ControlButton>
			<ControlButton
				pressed={props.state.mirrored}
				onClick={() => props.setState("mirrored", (mirrored) => !mirrored)}
			>
				<IconCapArrows class="size-5.5" />
			</ControlButton>
			<ControlButton
				pressed={
					props.state.backgroundBlur !== "off" &&
					props.state.backgroundBlur !== false
				}
				onClick={() =>
					props.setState("backgroundBlur", (mode) => cycleBlurMode(mode))
				}
			>
				<div class="relative">
					<IconLucidePersonStanding class="size-5.5" />
					<Show
						when={
							props.state.backgroundBlur !== "off" &&
							props.state.backgroundBlur !== false
						}
					>
						<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[7px] font-bold leading-none whitespace-nowrap">
							{blurModeLabel(props.state.backgroundBlur)}
						</span>
					</Show>
				</div>
			</ControlButton>
		</div>
	);
}

function ControlButton(
	props: Omit<ComponentProps<typeof KToggleButton>, "type" | "class">,
) {
	return (
		<KToggleButton
			type="button"
			class="p-2 rounded-lg data-pressed:bg-gray-3 data-pressed:text-gray-12"
			{...props}
		/>
	);
}

export function CameraResizeHandles(props: {
	state: CameraWindowState;
	setState: SetStoreFunction<CameraWindowState>;
	toolbarHeight: number;
	visible: boolean;
}) {
	const [isResizing, setIsResizing] = createSignal(false);
	const [activeCorner, setActiveCorner] = createSignal<ResizeCorner | null>(
		null,
	);
	const [resizeStart, setResizeStart] = createSignal({
		size: 0,
		x: 0,
		y: 0,
		corner: "nw" as ResizeCorner,
	});

	const handleResizeStart = (corner: ResizeCorner) => (e: MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		setIsResizing(true);
		setActiveCorner(corner);
		setResizeStart({
			size: props.state.size,
			x: e.clientX,
			y: e.clientY,
			corner,
		});
	};

	const handleResizeMove = (e: MouseEvent) => {
		if (!isResizing()) return;
		const start = resizeStart();
		const deltaX = e.clientX - start.x;
		const deltaY = e.clientY - start.y;

		const hasE = start.corner.includes("e");
		const hasW = start.corner.includes("w");
		const hasS = start.corner.includes("s");
		const hasN = start.corner.includes("n");

		const dx = hasE ? deltaX : hasW ? -deltaX : 0;
		const dy = hasS ? deltaY : hasN ? -deltaY : 0;

		const delta = (hasE || hasW) && (hasN || hasS) ? Math.max(dx, dy) : dx + dy;

		props.setState("size", clampCameraSize(start.size + delta));
	};

	const handleResizeEnd = () => {
		setIsResizing(false);
		setActiveCorner(null);
	};

	createEffect(() => {
		if (!isResizing()) return;
		window.addEventListener("mousemove", handleResizeMove);
		window.addEventListener("mouseup", handleResizeEnd);
		onCleanup(() => {
			window.removeEventListener("mousemove", handleResizeMove);
			window.removeEventListener("mouseup", handleResizeEnd);
		});
	});

	return (
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 z-20"
			style={{ top: `${props.toolbarHeight}px` }}
		>
			{RESIZE_CORNERS.map((corner) => (
				<ResizeCornerHandle
					corner={corner}
					onMouseDown={handleResizeStart(corner)}
					active={activeCorner() === corner}
					visible={props.visible || isResizing()}
				/>
			))}
		</div>
	);
}

function ResizeCornerHandle(props: {
	corner: ResizeCorner;
	onMouseDown: (e: MouseEvent) => void;
	active: boolean;
	visible: boolean;
}) {
	const hitAreaClass = () => {
		switch (props.corner) {
			case "nw":
				return "top-0 left-0 cursor-nw-resize";
			case "ne":
				return "top-0 right-0 cursor-ne-resize";
			case "sw":
				return "bottom-0 left-0 cursor-sw-resize";
			case "se":
				return "bottom-0 right-0 cursor-se-resize";
		}
	};

	const bracketPositionClass = () => {
		switch (props.corner) {
			case "nw":
				return "top-1.5 left-1.5 border-t-2 border-l-2 rounded-tl-[6px]";
			case "ne":
				return "top-1.5 right-1.5 border-t-2 border-r-2 rounded-tr-[6px]";
			case "sw":
				return "bottom-1.5 left-1.5 border-b-2 border-l-2 rounded-bl-[6px]";
			case "se":
				return "bottom-1.5 right-1.5 border-b-2 border-r-2 rounded-br-[6px]";
		}
	};

	return (
		<div
			data-tauri-drag-region="false"
			class={cx(
				"absolute z-20 w-7 h-7 group/handle select-none",
				hitAreaClass(),
			)}
			style={{ "pointer-events": "auto" }}
			onMouseDown={props.onMouseDown}
		>
			<div
				class={cx(
					"absolute w-3.5 h-3.5 border-white pointer-events-none",
					"transition-[opacity,transform,border-color] duration-150 ease-out",
					"opacity-0 scale-90",
					props.visible && "opacity-70 scale-100",
					"group-hover/handle:!opacity-100 group-hover/handle:!scale-110",
					props.active && "!opacity-100 !scale-110",
					bracketPositionClass(),
				)}
				style={{
					filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))",
				}}
			/>
		</div>
	);
}
