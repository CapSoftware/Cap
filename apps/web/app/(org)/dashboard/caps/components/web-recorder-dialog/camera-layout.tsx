"use client";

import type { RecorderCameraLayout } from "@cap/editor-cap-bundle/default-style";
import clsx from "clsx";
import {
	FlipHorizontal2Icon,
	Maximize2Icon,
	Minimize2Icon,
} from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

export type CameraLayout = Omit<RecorderCameraLayout, "version">;
type XPosition = CameraLayout["position"]["x"];
type YPosition = CameraLayout["position"]["y"];

// Like the desktop camera preview: a normal size and a large one.
export const CAMERA_SIZE_NORMAL = 30;
export const CAMERA_SIZE_LARGE = 42;

export const DEFAULT_CAMERA_LAYOUT: CameraLayout = {
	position: { x: "right", y: "bottom" },
	size: 30,
	mirror: false,
	shape: "round",
};

const STORAGE_KEY = "cap-web-recorder-camera-layout";
const X_POSITIONS: XPosition[] = ["left", "center", "right"];
const Y_POSITIONS: YPosition[] = ["top", "bottom"];

export const useCameraLayout = () => {
	const [layout, setLayoutState] = useState<CameraLayout>(
		DEFAULT_CAMERA_LAYOUT,
	);

	useEffect(() => {
		try {
			const stored = JSON.parse(
				window.localStorage.getItem(STORAGE_KEY) ?? "null",
			) as Partial<CameraLayout> | null;
			if (!stored) return;
			setLayoutState((current) => ({
				position:
					stored.position &&
					X_POSITIONS.includes(stored.position.x) &&
					Y_POSITIONS.includes(stored.position.y)
						? stored.position
						: current.position,
				size:
					stored.size === CAMERA_SIZE_LARGE
						? CAMERA_SIZE_LARGE
						: CAMERA_SIZE_NORMAL,
				mirror:
					typeof stored.mirror === "boolean" ? stored.mirror : current.mirror,
				shape:
					stored.shape === "round" ||
					stored.shape === "square" ||
					stored.shape === "full"
						? stored.shape
						: current.shape,
			}));
		} catch {
			/* defaults */
		}
	}, []);

	const setLayout = useCallback((update: Partial<CameraLayout>) => {
		setLayoutState((current) => {
			const next = { ...current, ...update };
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				/* remembered for this visit only */
			}
			return next;
		});
	}, []);

	return [layout, setLayout] as const;
};

type Rect = { left: number; top: number; width: number; height: number };

// The editor's camera maths (crates/rendering compute_camera_position): the
// camera is `min_axis * size% + padding` on its short side, inset by the same
// 50px-at-1080p padding from the edges it's anchored to.
const cameraRect = (
	frame: { width: number; height: number },
	layout: CameraLayout,
	cameraAspect: number,
	position = layout.position,
): Rect => {
	const minAxis = Math.min(frame.width, frame.height);
	const padding = (frame.height / 1080) * 50;
	const side = minAxis * (layout.size / 100) + padding;
	const aspect = layout.shape === "full" ? cameraAspect : 1;
	const width = aspect >= 1 ? side * aspect : side;
	const height = aspect >= 1 ? side : side / aspect;
	const left =
		position.x === "left"
			? padding
			: position.x === "center"
				? (frame.width - width) / 2
				: frame.width - padding - width;
	const top = position.y === "top" ? padding : frame.height - padding - height;
	return { left, top, width, height };
};

const nearestPosition = (
	frame: { width: number; height: number },
	layout: CameraLayout,
	cameraAspect: number,
	centre: { x: number; y: number },
) => {
	let best = layout.position;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const x of X_POSITIONS) {
		for (const y of Y_POSITIONS) {
			const rect = cameraRect(frame, layout, cameraAspect, { x, y });
			const distance = Math.hypot(
				rect.left + rect.width / 2 - centre.x,
				rect.top + rect.height / 2 - centre.y,
			);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = { x, y };
			}
		}
	}
	return best;
};

export const CameraBubble = ({
	frame,
	layout,
	cameraAspect,
	locked,
	onChange,
	children,
	label,
}: {
	frame: { width: number; height: number } | null;
	layout: CameraLayout;
	cameraAspect: number;
	locked: boolean;
	onChange: (update: Partial<CameraLayout>) => void;
	children: ReactNode;
	label: ReactNode;
}) => {
	const [drag, setDrag] = useState<{
		left: number;
		top: number;
		offsetX: number;
		offsetY: number;
	} | null>(null);
	const dragRef = useRef(drag);
	dragRef.current = drag;

	if (!frame || frame.width === 0) return null;
	const rest = cameraRect(frame, layout, cameraAspect);
	const rect = drag ? { ...rest, left: drag.left, top: drag.top } : rest;
	// The editor draws rounding 100 as a squircle, not a circle; match it.
	const radius =
		Math.min(rect.width, rect.height) *
		(layout.shape === "round" ? 0.3 : 0.075);
	const target = drag
		? nearestPosition(frame, layout, cameraAspect, {
				x: drag.left + rest.width / 2,
				y: drag.top + rest.height / 2,
			})
		: null;
	const ghost = target ? cameraRect(frame, layout, cameraAspect, target) : null;

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (locked || event.button !== 0) return;
		if ((event.target as HTMLElement).closest("button")) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const bounds = event.currentTarget.getBoundingClientRect();
		setDrag({
			left: rest.left,
			top: rest.top,
			offsetX: event.clientX - bounds.left,
			offsetY: event.clientY - bounds.top,
		});
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = dragRef.current;
		if (!current) return;
		const parent = event.currentTarget.parentElement?.getBoundingClientRect();
		if (!parent) return;
		setDrag({
			...current,
			left: Math.min(
				Math.max(event.clientX - parent.left - current.offsetX, 0),
				frame.width - rest.width,
			),
			top: Math.min(
				Math.max(event.clientY - parent.top - current.offsetY, 0),
				frame.height - rest.height,
			),
		});
	};
	const endDrag = () => {
		const current = dragRef.current;
		if (!current) return;
		const position = nearestPosition(frame, layout, cameraAspect, {
			x: current.left + rest.width / 2,
			y: current.top + rest.height / 2,
		});
		setDrag(null);
		onChange({ position });
	};

	const toolbarAbove = layout.position.y === "bottom";

	return (
		<>
			{drag && ghost && (
				<span
					className="pointer-events-none absolute bg-white/15 shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.35)] transition-[left,top] duration-200 ease-[cubic-bezier(.2,.8,.2,1)]"
					style={{
						left: ghost.left,
						top: ghost.top,
						width: ghost.width,
						height: ghost.height,
						borderRadius: radius,
					}}
				/>
			)}
			<div
				className={clsx(
					"group/cam absolute touch-none",
					!locked && (drag ? "cursor-grabbing" : "cursor-grab"),
					!drag &&
						"transition-[left,top,width,height,border-radius] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]",
				)}
				style={{
					left: rect.left,
					top: rect.top,
					width: rect.width,
					height: rect.height,
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				<div
					className="absolute inset-0 overflow-hidden bg-black shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)] ring-1 ring-white/15 transition-[border-radius] duration-300"
					style={{ borderRadius: radius }}
				>
					{children}
					{label}
				</div>
				{!locked && !drag && (
					<div
						className={clsx(
							"absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-black/70 p-0.5 text-white opacity-0 shadow-lg backdrop-blur-md transition-opacity focus-within:opacity-100 group-hover/cam:opacity-100",
							toolbarAbove ? "bottom-full mb-2" : "top-full mt-2",
						)}
					>
						<CamButton
							active={layout.size === CAMERA_SIZE_LARGE}
							label={
								layout.size === CAMERA_SIZE_LARGE
									? "Make camera smaller"
									: "Make camera bigger"
							}
							onClick={() =>
								onChange({
									size:
										layout.size === CAMERA_SIZE_LARGE
											? CAMERA_SIZE_NORMAL
											: CAMERA_SIZE_LARGE,
								})
							}
						>
							{layout.size === CAMERA_SIZE_LARGE ? (
								<Minimize2Icon className="size-3.5" aria-hidden />
							) : (
								<Maximize2Icon className="size-3.5" aria-hidden />
							)}
						</CamButton>
						<span className="mx-0.5 h-4 w-px bg-white/20" />
						{(["round", "square", "full"] as const).map((shape) => (
							<CamButton
								key={shape}
								active={layout.shape === shape}
								label={
									shape === "round"
										? "Round camera"
										: shape === "square"
											? "Square camera"
											: "Full frame camera"
								}
								onClick={() => onChange({ shape })}
							>
								<span
									className={clsx(
										"border-[1.5px] border-current",
										shape === "round"
											? "size-3 rounded-full"
											: shape === "square"
												? "size-3 rounded-[3px]"
												: "h-2.5 w-3.5 rounded-[2px]",
									)}
								/>
							</CamButton>
						))}
						<span className="mx-0.5 h-4 w-px bg-white/20" />
						<CamButton
							active={layout.mirror}
							label="Flip camera"
							onClick={() => onChange({ mirror: !layout.mirror })}
						>
							<FlipHorizontal2Icon className="size-3.5" aria-hidden />
						</CamButton>
					</div>
				)}
			</div>
		</>
	);
};

const CamButton = ({
	active,
	label,
	onClick,
	children,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
	children: ReactNode;
}) => (
	<button
		type="button"
		aria-label={label}
		aria-pressed={active}
		title={label}
		onClick={onClick}
		className={clsx(
			"flex size-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
			active ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10",
		)}
	>
		{children}
	</button>
);
