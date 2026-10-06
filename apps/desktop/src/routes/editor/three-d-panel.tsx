import { Collapsible as KCollapsible } from "@kobalte/core/collapsible";
import { Select as KSelect } from "@kobalte/core/select";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	type JSX,
	on,
	onCleanup,
	type ParentProps,
	Show,
	type ValidComponent,
} from "solid-js";
import { produce } from "solid-js/store";
import { Toggle } from "~/components/Toggle";
import IconLucideArrowLeftRight from "~icons/lucide/arrow-left-right";
import IconLucideArrowRight from "~icons/lucide/arrow-right";
import IconLucideFlipHorizontal2 from "~icons/lucide/flip-horizontal-2";
import IconLucideFlipVertical2 from "~icons/lucide/flip-vertical-2";
import { FPS, useEditorContext } from "./context";
import {
	ANGLE_PRESETS,
	anglePresetMotion,
	CAMERA3D_BLUR_MODE_SEEDS,
	CAMERA3D_BOKEH_MAX_STRENGTH,
	CAMERA3D_LIMITS,
	CAMERA3D_RESET_POSE,
	CAMERA3D_SCENE_DESCRIPTIONS,
	CAMERA3D_SCENES,
	CAMERA3D_TRANSITION_LIMITS,
	type Camera3DBlurMode,
	type Camera3DBlurScalarKey,
	type Camera3DFlipAxis,
	type Camera3DMotionEasing,
	type Camera3DMotionTemplate,
	type Camera3DProperties,
	type Camera3DPropertyKey,
	type Camera3DScene,
	type Camera3DSegment,
	camera3DPoseSeekTime,
	camera3DPosesEqual,
	camera3DShotLabel,
	camera3dBlurLimit,
	cssPreviewTransform,
	flipCamera3DSegment,
	getEndPose,
	getMotionEasing,
	getStartPose,
	MAX_AUTO_CAMERA3D_SHOTS,
	MOTION_EASINGS,
	MOTION_TEMPLATES,
	matchCamera3DLook,
	maxAutoCamera3DShots,
	setMotion,
} from "./three-d";
import {
	EditorButton,
	Field,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	Subfield,
	topSlideAnimateClasses,
} from "./ui";

export const camera3DShotSummary = (segment: Camera3DSegment) =>
	`3D shot · ${camera3DShotLabel(segment)} · ${(segment.end - segment.start).toFixed(1)}s`;

const LOOK_TILE_HEIGHT = 62;
const POSE_CARD_HEIGHT = 104;
const ORBIT_PAD_SIZE = 132;
const PREVIEW_TRANSITION = "700ms ease-in-out";

// Which half of the Look grid was last open. Panel-local state would reset
// every time another shot is selected, which is not what the user meant.
const [lookTab, setLookTab] = createSignal<"moves" | "angles">("moves");

const BLUR_MODE_LABELS: Record<Exclude<Camera3DBlurMode, "none">, string> = {
	radial: "Radial",
	directional: "Directional",
	tiltShift: "Tilt shift",
};

const BLUR_FINE_SLIDERS: Record<
	Exclude<Camera3DBlurMode, "none">,
	Array<{ key: Camera3DBlurScalarKey; label: string; unit: string }>
> = {
	radial: [
		{ key: "focusX", label: "Focus X", unit: "" },
		{ key: "focusY", label: "Focus Y", unit: "" },
		{ key: "focusSize", label: "Focus size", unit: "" },
		{ key: "falloff", label: "Falloff", unit: "" },
	],
	directional: [
		{ key: "angle", label: "Angle", unit: "°" },
		{ key: "dirPosition", label: "Position", unit: "" },
		{ key: "falloff", label: "Falloff", unit: "" },
	],
	tiltShift: [
		{ key: "focusY", label: "Scan", unit: "" },
		{ key: "focusSize", label: "Focus size", unit: "" },
		{ key: "angle", label: "Angle", unit: "°" },
		{ key: "falloff", label: "Falloff", unit: "" },
	],
};

const DEFAULT_BLUR_STRENGTH = 19;

export function ShotCountPills(props: {
	max: number;
	current?: number | null;
	onHover: (count: number | null) => void;
	onPick: (count: number) => void;
}) {
	return (
		<div class="flex flex-row gap-1 items-center">
			<For
				each={Array.from({ length: MAX_AUTO_CAMERA3D_SHOTS }, (_, i) => i + 1)}
			>
				{(count) => (
					<button
						type="button"
						disabled={count > props.max}
						data-selected={props.current === count}
						title={
							count > props.max
								? "This recording is too short for that many shots"
								: `${count} ${count === 1 ? "shot" : "shots"}`
						}
						onMouseEnter={() => {
							if (count <= props.max) props.onHover(count);
						}}
						onMouseLeave={() => props.onHover(null)}
						onFocus={() => {
							if (count <= props.max) props.onHover(count);
						}}
						onBlur={() => props.onHover(null)}
						onClick={() => {
							if (count <= props.max) props.onPick(count);
						}}
						class="cap-shot-pill outline-hidden"
					>
						{count}
					</button>
				)}
			</For>
		</div>
	);
}

function PanelGroup(
	props: ParentProps<{ name: string; action?: JSX.Element }>,
) {
	return (
		<div class="p-3 rounded-[10px] shadow-[0_0_0_1px_var(--ed-line)]">
			<div class="flex flex-row gap-2 items-center min-h-[22px]">
				<span class="text-[12px] font-medium text-ed-text-2">{props.name}</span>
				<Show when={props.action}>
					<div class="flex flex-row gap-1.5 items-center ml-auto">
						{props.action}
					</div>
				</Show>
			</div>
			<div class="mt-2.5">{props.children}</div>
		</div>
	);
}

function MiniSegmented<T extends string>(props: {
	value: T;
	options: Array<{ value: T; label: string; disabled?: boolean }>;
	onChange: (value: T) => void;
	class?: string;
}) {
	return (
		<div
			class={cx(
				"flex flex-row gap-0.5 p-0.5 rounded-[7px] bg-ed-ctl",
				props.class,
			)}
		>
			<For each={props.options}>
				{(option) => (
					<button
						type="button"
						disabled={option.disabled}
						aria-pressed={props.value === option.value}
						data-selected={props.value === option.value}
						onClick={() => props.onChange(option.value)}
						class="flex-1 px-2.5 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap transition-colors duration-100 outline-hidden text-ed-text-2 data-[selected='true']:bg-ed-card data-[selected='true']:text-ed-text-1 data-[selected='true']:shadow-[0_1px_2px_rgba(0,0,0,.12),0_0_0_.5px_rgba(0,0,0,.06)] dark:data-[selected='true']:bg-white/11 dark:data-[selected='true']:shadow-none not-data-[selected='true']:hover:text-ed-text-1 disabled:opacity-40"
					>
						{option.label}
					</button>
				)}
			</For>
		</div>
	);
}

/**
 * The same label | control | value row as `Field inline`, with a narrower
 * label: the Camera group's sliders share their row with the orbit pad, and the
 * sidebar's standard 96px label would leave them barely draggable.
 */
function CompactRow(props: ParentProps<{ name: string; value?: string }>) {
	return (
		<div class="flex flex-row gap-2 items-center h-8">
			<span class="w-[70px] shrink-0 truncate text-[13px] text-ed-text-1">
				{props.name}
			</span>
			<div class="flex flex-row flex-1 gap-2 items-center min-w-0 [&>.ed-slider]:flex-1">
				{props.children}
			</div>
			<Show when={props.value}>
				<span class="shrink-0 min-w-9 text-[11px] text-right tabular-nums text-ed-text-3">
					{props.value}
				</span>
			</Show>
		</div>
	);
}

/**
 * The pose as a card in space: perspective reproduces the field of view at
 * this height and the rotations run in the renderer's order, so the thumbnail
 * is the shot rather than an illustration of it.
 */
function PoseCard(props: {
	pose: Camera3DProperties;
	height: number;
	widthPercent: number;
	animate?: boolean;
}) {
	const style = () => cssPreviewTransform(props.pose, props.height);

	return (
		<div
			class="flex absolute inset-0 justify-center items-center"
			style={{
				perspective: `${style().perspective}px`,
				transition: props.animate
					? `perspective ${PREVIEW_TRANSITION}`
					: undefined,
			}}
		>
			<div
				class="relative rounded-[2px] bg-ed-thumb shadow-[0_6px_14px_-6px_rgba(0,0,0,.55)]"
				style={{
					width: `${props.widthPercent}%`,
					"aspect-ratio": "16 / 10",
					transform: style().transform,
					transition: props.animate
						? `transform ${PREVIEW_TRANSITION}`
						: undefined,
				}}
			>
				<div class="absolute left-[10%] right-[30%] top-[22%] h-[9%] rounded-[2px] bg-black/25" />
				<div class="absolute left-[10%] right-[15%] top-[44%] h-[9%] rounded-[2px] bg-black/25" />
				<div
					class="absolute left-[10%] top-[66%] h-[9%] w-[35%] rounded-[2px] opacity-90"
					style={{ "background-color": "var(--track-3d)" }}
				/>
			</div>
		</div>
	);
}

function LookTile(props: {
	look: Camera3DMotionTemplate;
	selected: boolean;
	moves: boolean;
	onClick: () => void;
}) {
	const [hovered, setHovered] = createSignal(false);

	return (
		<button
			type="button"
			onClick={() => props.onClick()}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setHovered(true)}
			onBlur={() => setHovered(false)}
			aria-pressed={props.selected}
			title={props.look.name}
			class="flex flex-col gap-1.5 items-center outline-hidden group"
		>
			<div
				class={cx(
					"overflow-hidden relative w-full rounded-lg aspect-[4/3] bg-ed-ctl-active transition-shadow",
					props.selected
						? "shadow-[0_0_0_2px_var(--ed-accent)]"
						: "shadow-[inset_0_0_0_1px_var(--ed-line)] group-hover:shadow-[inset_0_0_0_1px_var(--ed-line-strong)]",
				)}
			>
				<PoseCard
					animate
					pose={hovered() ? props.look.to : props.look.from}
					height={LOOK_TILE_HEIGHT}
					widthPercent={75}
				/>
				<Show when={props.moves}>
					<span class="absolute right-1 bottom-1 px-1 rounded text-[10px] leading-[14px] bg-ed-card text-ed-text-2 shadow-[0_0_0_1px_var(--ed-line)]">
						<IconLucideArrowRight class="size-2.5" />
					</span>
				</Show>
			</div>
			<span
				class={cx(
					"text-[11px] leading-tight truncate max-w-full",
					props.selected
						? "font-medium text-ed-text-1"
						: "text-ed-text-2 group-hover:text-ed-text-1",
				)}
			>
				{props.look.name}
			</span>
		</button>
	);
}

function SequenceCard(props: { scene: Camera3DScene; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={() => props.onClick()}
			title={CAMERA3D_SCENE_DESCRIPTIONS[props.scene.id]}
			class="flex flex-col gap-[3px] items-start px-2.5 py-2 text-left rounded-lg transition-colors outline-hidden bg-ed-ctl hover:bg-ed-ctl-hover"
		>
			<span class="text-[11px] font-medium text-ed-text-1">
				{props.scene.name}
			</span>
			<span class="text-[10px] text-ed-text-2">
				{props.scene.shots.length} shots
			</span>
			<div class="flex gap-[3px] mt-[3px] w-full">
				<For each={props.scene.shots}>
					{() => (
						<span
							class="flex-1 h-1 rounded-sm opacity-60"
							style={{ "background-color": "var(--track-3d)" }}
						/>
					)}
				</For>
			</div>
		</button>
	);
}

function OrbitPad(props: {
	pose: Camera3DProperties;
	onChange: (tiltX: number, tiltY: number) => void;
	onReset: () => void;
}) {
	const { projectHistory } = useEditorContext();

	const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
	const x = () =>
		clamp01(
			(props.pose.tiltY - CAMERA3D_LIMITS.tiltY.min) /
				(CAMERA3D_LIMITS.tiltY.max - CAMERA3D_LIMITS.tiltY.min),
		);
	const y = () =>
		clamp01(
			(CAMERA3D_LIMITS.tiltX.max - props.pose.tiltX) /
				(CAMERA3D_LIMITS.tiltX.max - CAMERA3D_LIMITS.tiltX.min),
		);

	const onPick = (downEvent: MouseEvent) => {
		downEvent.preventDefault();
		const rect = (
			downEvent.currentTarget as HTMLElement
		).getBoundingClientRect();
		const resumeHistory = projectHistory.pause();
		const apply = (event: MouseEvent) => {
			const fx = clamp01((event.clientX - rect.left) / rect.width);
			const fy = clamp01((event.clientY - rect.top) / rect.height);
			props.onChange(
				CAMERA3D_LIMITS.tiltX.max -
					fy * (CAMERA3D_LIMITS.tiltX.max - CAMERA3D_LIMITS.tiltX.min),
				CAMERA3D_LIMITS.tiltY.min +
					fx * (CAMERA3D_LIMITS.tiltY.max - CAMERA3D_LIMITS.tiltY.min),
			);
		};
		apply(downEvent);
		createRoot((dispose) =>
			createEventListenerMap(window, {
				mousemove: apply,
				mouseup: () => {
					resumeHistory();
					dispose();
				},
			}),
		);
	};

	return (
		<div
			class="overflow-hidden relative shrink-0 rounded-[10px] bg-ed-ctl-active shadow-[inset_0_0_0_1px_var(--ed-line)] cursor-crosshair"
			style={{ width: `${ORBIT_PAD_SIZE}px`, height: `${ORBIT_PAD_SIZE}px` }}
			onMouseDown={onPick}
			onDblClick={() => props.onReset()}
		>
			<div
				class="absolute inset-0 pointer-events-none"
				style={{
					"background-image":
						"linear-gradient(var(--ed-line) 1px, transparent 1px), linear-gradient(90deg, var(--ed-line) 1px, transparent 1px)",
					"background-size": "33.3% 33.3%",
				}}
			/>
			<PoseCard pose={props.pose} height={ORBIT_PAD_SIZE} widthPercent={62} />
			<div
				class="absolute rounded-full pointer-events-none size-3 -translate-x-1/2 -translate-y-1/2 bg-ed-accent shadow-[0_0_0_3px_var(--ed-card)]"
				style={{ left: `${x() * 100}%`, top: `${y() * 100}%` }}
			/>
			<span class="absolute inset-x-0 bottom-1.5 text-[10px] text-center pointer-events-none text-ed-text-2">
				Drag to orbit
			</span>
		</div>
	);
}

function DrillSection(
	props: ParentProps<{
		name: string;
		summary?: string;
		subtle?: boolean;
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}>,
) {
	return (
		<KCollapsible
			open={props.open}
			onOpenChange={props.onOpenChange}
			class={cx(
				!props.subtle && "rounded-[10px] shadow-[0_0_0_1px_var(--ed-line)]",
			)}
		>
			<KCollapsible.Trigger
				class={cx(
					"flex flex-row gap-2 items-center w-full font-medium group outline-hidden",
					props.subtle
						? "h-[26px] text-[12px] text-ed-text-2 hover:text-ed-text-1"
						: "px-3 h-9 text-[13px] text-ed-text-1",
				)}
			>
				{props.name}
				<span class="flex flex-row gap-1.5 items-center ml-auto text-[11px] font-normal text-ed-text-3">
					{props.summary}
					<IconCapChevronDown class="transition-transform duration-200 size-3.5 group-data-expanded:rotate-180" />
				</span>
			</KCollapsible.Trigger>
			<KCollapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
				<div class={cx(props.subtle ? "pt-1" : "px-3 pt-1 pb-3")}>
					{props.children}
				</div>
			</KCollapsible.Content>
		</KCollapsible>
	);
}

const formatShotTime = (seconds: number) => {
	const clamped = Math.max(seconds, 0);
	const minutes = Math.floor(clamped / 60);
	return `${minutes}:${(clamped - minutes * 60).toFixed(1).padStart(4, "0")}`;
};

export function Camera3DShotPanel(props: {
	segmentIndex: number;
	segment: Camera3DSegment;
}) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		projectActions,
		totalDuration,
	} = useEditorContext();

	const updateSegment = (fn: (segment: Camera3DSegment) => void) => {
		setProject(
			"timeline",
			"camera3dSegments",
			produce((segments) => {
				const target = segments?.[props.segmentIndex];
				if (!target) return;
				fn(target);
			}),
		);
	};

	const startPose = () => getStartPose(props.segment);
	const endPose = () => getEndPose(props.segment);
	const isStill = () => camera3DPosesEqual(startPose(), endPose());

	const editingEnd = () => editorState.timeline.camera3dPose === "end";
	const setEditingEnd = (end: boolean) =>
		setEditorState("timeline", "camera3dPose", end ? "end" : "start");
	const selectedPose = () => (editingEnd() ? endPose() : startPose());

	createEffect(
		on(
			() => props.segmentIndex,
			() => setEditingEnd(false),
			{ defer: true },
		),
	);

	// Open the Look grid on the half that holds this shot's card, so the ring
	// is on screen instead of one tab away. Keyed on the shot alone: while the
	// shot is being edited the tab is the user's, not the match's.
	createEffect(
		on(
			() => props.segmentIndex,
			() => {
				const look = matchCamera3DLook(props.segment);
				if (look) setLookTab(look.kind === "angle" ? "angles" : "moves");
			},
		),
	);

	const selectPose = (end: boolean) =>
		projectActions.selectCamera3DPose(props.segmentIndex, end);

	const playheadOnPose = (end: boolean) =>
		Math.abs(
			editorState.playbackTime - camera3DPoseSeekTime(props.segment, end, FPS),
		) <
		1 / FPS;

	const writeMotion = (
		start: Camera3DProperties,
		end: Camera3DProperties,
		easing = getMotionEasing(props.segment),
	) => updateSegment((segment) => setMotion(segment, start, end, easing));

	// Editing the start of a still shot moves both ends, so dialling in a hold
	// never turns into an unrequested move. Editing the end is the explicit way
	// out: the first value that changes there makes the shot a move.
	const writeSelectedPose = (pose: Camera3DProperties) => {
		if (editingEnd()) writeMotion(startPose(), pose);
		else if (isStill()) writeMotion(pose, pose);
		else writeMotion(pose, endPose());
	};

	const setPoseProperty = (key: Camera3DPropertyKey, value: number) =>
		writeSelectedPose({ ...selectedPose(), [key]: value });

	const swapPoses = () => {
		const start = startPose();
		writeMotion(endPose(), start);
	};

	const makeStill = () => {
		const start = startPose();
		batch(() => {
			writeMotion(start, start);
			setEditingEnd(false);
		});
	};

	const flipSegment = (axis: Camera3DFlipAxis) =>
		updateSegment((segment) => flipCamera3DSegment(segment, axis));

	const resetCamera = () => writeSelectedPose({ ...CAMERA3D_RESET_POSE });

	const looks = createMemo(() =>
		lookTab() === "moves"
			? MOTION_TEMPLATES.map((template) => ({ id: template.id, template }))
			: ANGLE_PRESETS.map((preset) => ({
					id: preset.id,
					template: anglePresetMotion(preset),
				})),
	);
	const activeLook = () => matchCamera3DLook(props.segment);

	const applyLook = (look: Camera3DMotionTemplate) =>
		batch(() => {
			projectActions.applyCamera3DLook(props.segmentIndex, look);
			setEditingEnd(false);
		});

	const motionEasing = () => getMotionEasing(props.segment);
	const blur = () => props.segment.blur;
	const blurOn = () => blur().mode !== "none";
	const activeBlurMode = () =>
		blur().mode === "none"
			? "radial"
			: (blur().mode as Exclude<Camera3DBlurMode, "none">);

	const [lastBlurMode, setLastBlurMode] =
		createSignal<Exclude<Camera3DBlurMode, "none">>("radial");

	const seedBlurMode = (
		segment: Camera3DSegment,
		mode: Exclude<Camera3DBlurMode, "none">,
	) => {
		segment.blur.mode = mode;
		const seed = CAMERA3D_BLUR_MODE_SEEDS[mode];
		for (const key of Object.keys(seed) as Camera3DBlurScalarKey[]) {
			const value = seed[key];
			if (value !== undefined) segment.blur[key] = value;
		}
	};

	const setBlurEnabled = (enabled: boolean) => {
		if (!enabled) {
			if (blur().mode !== "none") setLastBlurMode(activeBlurMode());
			// The scalars stay: switching back on returns the same defocus.
			updateSegment((segment) => {
				segment.blur.mode = "none";
			});
			return;
		}
		if (blurOn()) return;
		updateSegment((segment) => {
			seedBlurMode(segment, lastBlurMode());
			if (segment.blur.strength <= 0)
				segment.blur.strength = segment.blur.bokeh
					? Math.min(DEFAULT_BLUR_STRENGTH, CAMERA3D_BOKEH_MAX_STRENGTH)
					: DEFAULT_BLUR_STRENGTH;
		});
	};

	const setBlurMode = (mode: Exclude<Camera3DBlurMode, "none">) => {
		if (mode === blur().mode) return;
		setLastBlurMode(mode);
		updateSegment((segment) => seedBlurMode(segment, mode));
	};

	// Blur is segment-level and static: it is never part of the move.
	const setBlurValue = (key: Camera3DBlurScalarKey, value: number) =>
		updateSegment((segment) => {
			segment.blur[key] = value;
		});

	const setBokeh = (enabled: boolean) =>
		updateSegment((segment) => {
			segment.blur.bokeh = enabled;
			if (!enabled) return;
			// The bokeh kernel tops out at 20, so pull the strength down with the
			// slider's new ceiling.
			segment.blur.strength = Math.min(
				segment.blur.strength,
				CAMERA3D_BOKEH_MAX_STRENGTH,
			);
		});

	const [fineTuneOpen, setFineTuneOpen] = createSignal(false);
	const [advancedOpen, setAdvancedOpen] = createSignal(false);

	onCleanup(() => setEditorState("timeline", "camera3dAutoPreview", null));

	const shotCount = () => project.timeline?.camera3dSegments?.length ?? 0;
	const autoSceneCount = () =>
		shotCount() >= 1 && shotCount() <= MAX_AUTO_CAMERA3D_SHOTS
			? shotCount()
			: null;

	const poseCaption = (end: boolean) => {
		if (end && isStill()) return "End · same as start";
		const time = end ? props.segment.end : props.segment.start;
		return `${end ? "End" : "Start"} · ${formatShotTime(time)}`;
	};

	const poseTile = (end: boolean) => (
		<button
			type="button"
			onClick={() => selectPose(end)}
			aria-pressed={editingEnd() === end}
			class="flex flex-col flex-1 gap-1.5 items-start min-w-0 outline-hidden group"
		>
			<div
				class={cx(
					"overflow-hidden relative w-full rounded-lg bg-ed-ctl-active transition-shadow",
					editingEnd() === end
						? "shadow-[0_0_0_2px_var(--ed-accent)]"
						: "shadow-[inset_0_0_0_1px_var(--ed-line)] group-hover:shadow-[inset_0_0_0_1px_var(--ed-line-strong)]",
					end && isStill() && "opacity-45",
				)}
				style={{ height: `${POSE_CARD_HEIGHT}px` }}
			>
				<PoseCard
					pose={end ? endPose() : startPose()}
					height={POSE_CARD_HEIGHT}
					widthPercent={70}
				/>
			</div>
			<span class="flex flex-row gap-1.5 items-center max-w-full">
				<span
					class={cx(
						"text-[11px] leading-tight truncate",
						editingEnd() === end
							? "font-medium text-ed-text-1"
							: "text-ed-text-2",
					)}
				>
					{poseCaption(end)}
				</span>
				<Show when={playheadOnPose(end)}>
					<span class="rounded-full shrink-0 size-1.5 bg-ed-accent" />
				</Show>
			</span>
		</button>
	);

	const poseSliderControl = (key: Camera3DPropertyKey) => (
		<Slider
			value={[selectedPose()[key]]}
			onChange={(v) => setPoseProperty(key, v[0])}
			minValue={CAMERA3D_LIMITS[key].min}
			maxValue={CAMERA3D_LIMITS[key].max}
			step={CAMERA3D_LIMITS[key].step}
		/>
	);

	const poseSlider = (
		key: Camera3DPropertyKey,
		label: string,
		format: (value: number) => string,
	) => (
		<Field inline name={label} value={format(selectedPose()[key])}>
			{poseSliderControl(key)}
		</Field>
	);

	const compactPoseSlider = (
		key: Camera3DPropertyKey,
		label: string,
		format: (value: number) => string,
	) => (
		<CompactRow name={label} value={format(selectedPose()[key])}>
			{poseSliderControl(key)}
		</CompactRow>
	);

	return (
		<div class="flex flex-col gap-3">
			<div
				class="flex flex-row gap-2 items-center px-3 h-9 rounded-[10px] shadow-[0_0_0_1px_var(--ed-line)]"
				title="Rebuilds every 3D shot on the track"
			>
				<span class="text-[12px] font-medium text-ed-text-2">Auto scene</span>
				<div class="ml-auto">
					<ShotCountPills
						max={maxAutoCamera3DShots(totalDuration())}
						current={autoSceneCount()}
						onHover={(count) =>
							setEditorState("timeline", "camera3dAutoPreview", count)
						}
						onPick={(count) => projectActions.applyCamera3DAutoScene(count)}
					/>
				</div>
			</div>
			<PanelGroup
				name="Look"
				action={
					<MiniSegmented
						value={lookTab()}
						options={[
							{ value: "moves", label: "Moves" },
							{ value: "angles", label: "Angles" },
						]}
						onChange={setLookTab}
					/>
				}
			>
				<div class="grid grid-cols-4 gap-2">
					<For each={looks()}>
						{(look) => (
							<LookTile
								look={look.template}
								moves={lookTab() === "moves"}
								selected={
									activeLook()?.kind ===
										(lookTab() === "moves" ? "move" : "angle") &&
									activeLook()?.id === look.id
								}
								onClick={() => applyLook(look.template)}
							/>
						)}
					</For>
				</div>
				<div class="grid grid-cols-3 gap-2 mt-2.5">
					<For each={CAMERA3D_SCENES}>
						{(scene) => (
							<SequenceCard
								scene={scene}
								onClick={() =>
									projectActions.applyCamera3DScene(
										props.segmentIndex,
										scene.id,
									)
								}
							/>
						)}
					</For>
				</div>
			</PanelGroup>

			<PanelGroup
				name="Camera"
				action={
					<div class="flex flex-row gap-1 items-center">
						<EditorButton
							size="sm"
							onClick={() => flipSegment("horizontal")}
							tooltipText="Flip horizontal"
							leftIcon={<IconLucideFlipHorizontal2 />}
						/>
						<EditorButton
							size="sm"
							onClick={() => flipSegment("vertical")}
							tooltipText="Flip vertical"
							leftIcon={<IconLucideFlipVertical2 />}
						/>
					</div>
				}
			>
				<div class="flex flex-row gap-2 items-start">
					{poseTile(false)}
					<div
						class="flex items-center"
						style={{ height: `${POSE_CARD_HEIGHT}px` }}
					>
						<EditorButton
							size="sm"
							onClick={swapPoses}
							disabled={isStill()}
							tooltipText="Swap start and end"
							leftIcon={<IconLucideArrowLeftRight />}
						/>
					</div>
					{poseTile(true)}
				</div>
				<div class="flex flex-row gap-2 items-center mt-2">
					<EditorButton
						size="sm"
						onClick={makeStill}
						disabled={isStill()}
						tooltipText={
							isStill() ? "Already a still shot" : "Hold on the start pose"
						}
						leftIcon={<IconLucidePause />}
					>
						Still shot
					</EditorButton>
				</div>
				<div class="flex flex-row gap-3 mt-3">
					<OrbitPad
						pose={selectedPose()}
						onChange={(tiltX, tiltY) =>
							writeSelectedPose({ ...selectedPose(), tiltX, tiltY })
						}
						onReset={() =>
							writeSelectedPose({ ...selectedPose(), tiltX: 0, tiltY: 0 })
						}
					/>
					<div class="flex flex-col flex-1 justify-center min-w-0">
						{compactPoseSlider("zoom", "Distance", (value) => value.toFixed(2))}
						{compactPoseSlider(
							"roll",
							"Roll",
							(value) => `${Math.round(value)}°`,
						)}
						{compactPoseSlider("panX", "Shift X", (value) => value.toFixed(2))}
						{compactPoseSlider("panY", "Shift Y", (value) => value.toFixed(2))}
					</div>
				</div>
			</PanelGroup>

			<PanelGroup
				name="Depth blur"
				action={
					<Toggle size="sm" checked={blurOn()} onChange={setBlurEnabled} />
				}
			>
				<Show
					when={blurOn()}
					fallback={
						<p class="text-[11px] text-ed-text-3">
							Turn on to blur everything outside the focus area.
						</p>
					}
				>
					<Field inline name="Amount" value={`${Math.round(blur().strength)}`}>
						<Slider
							value={[blur().strength]}
							onChange={(v) => setBlurValue("strength", v[0])}
							minValue={camera3dBlurLimit("strength", blur()).min}
							maxValue={camera3dBlurLimit("strength", blur()).max}
							step={camera3dBlurLimit("strength", blur()).step}
						/>
					</Field>
					<Field inline name="Focus">
						<MiniSegmented
							class="flex-1"
							value={activeBlurMode()}
							options={(
								Object.keys(BLUR_MODE_LABELS) as Array<
									Exclude<Camera3DBlurMode, "none">
								>
							).map((mode) => ({ value: mode, label: BLUR_MODE_LABELS[mode] }))}
							onChange={setBlurMode}
						/>
					</Field>
					<DrillSection
						subtle
						name="Fine-tune"
						open={fineTuneOpen()}
						onOpenChange={setFineTuneOpen}
					>
						<For each={BLUR_FINE_SLIDERS[activeBlurMode()]}>
							{(slider) => {
								const limit = () => camera3dBlurLimit(slider.key, blur());
								return (
									<Field
										inline
										name={slider.label}
										value={`${blur()[slider.key].toFixed(2)}${slider.unit}`}
									>
										<Slider
											value={[blur()[slider.key]]}
											onChange={(v) => setBlurValue(slider.key, v[0])}
											minValue={limit().min}
											maxValue={limit().max}
											step={limit().step}
										/>
									</Field>
								);
							}}
						</For>
						<Subfield name="Bokeh">
							<Toggle size="sm" checked={blur().bokeh} onChange={setBokeh} />
						</Subfield>
					</DrillSection>
				</Show>
			</PanelGroup>

			<DrillSection
				name="Timing & advanced"
				summary={`${motionEasing().label} · Lens ${Math.round(selectedPose().fov)}`}
				open={advancedOpen()}
				onOpenChange={setAdvancedOpen}
			>
				<Field inline name="Motion style" disabled={isStill()}>
					<div class="w-40">
						<KSelect<Camera3DMotionEasing>
							options={MOTION_EASINGS}
							optionValue="id"
							optionTextValue="label"
							value={motionEasing()}
							onChange={(option) => {
								if (option) writeMotion(startPose(), endPose(), option);
							}}
							// A still shot has no span to shape, and nowhere to store a
							// curve, so the picker would silently snap back.
							disabled={isStill()}
							disallowEmptySelection
							itemComponent={(itemProps) => (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={itemProps.item}
								>
									<KSelect.ItemLabel class="flex-1">
										{itemProps.item.rawValue.label}
									</KSelect.ItemLabel>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class="flex flex-row gap-1.5 items-center px-2 w-full h-[26px] rounded-[7px] transition-colors bg-ed-ctl hover:bg-ed-ctl-hover outline-hidden disabled:text-ed-text-3">
								<KSelect.Value<Camera3DMotionEasing> class="flex-1 text-[12px] text-left truncate text-ed-text-1 font-normal">
									{(state) => <span>{state.selectedOption().label}</span>}
								</KSelect.Value>
								<KSelect.Icon<ValidComponent>
									as={(iconProps) => (
										<IconCapChevronDown
											{...iconProps}
											class="size-3.5 shrink-0 transform transition-transform data-expanded:rotate-180 text-ed-text-3"
										/>
									)}
								/>
							</KSelect.Trigger>
							<KSelect.Portal>
								<PopperContent<typeof KSelect.Content>
									as={KSelect.Content}
									class={cx(topSlideAnimateClasses, "z-50")}
								>
									<MenuItemList<typeof KSelect.Listbox>
										class="overflow-y-auto max-h-32"
										as={KSelect.Listbox}
									/>
								</PopperContent>
							</KSelect.Portal>
						</KSelect>
					</div>
				</Field>
				<Field
					inline
					name="Ease in"
					value={`${props.segment.transitionIn.toFixed(2)}s`}
				>
					<Slider
						value={[props.segment.transitionIn]}
						onChange={(v) =>
							updateSegment((segment) => {
								segment.transitionIn = v[0];
							})
						}
						minValue={CAMERA3D_TRANSITION_LIMITS.min}
						maxValue={CAMERA3D_TRANSITION_LIMITS.max}
						step={CAMERA3D_TRANSITION_LIMITS.step}
					/>
				</Field>
				<Field
					inline
					name="Ease out"
					value={`${props.segment.transitionOut.toFixed(2)}s`}
				>
					<Slider
						value={[props.segment.transitionOut]}
						onChange={(v) =>
							updateSegment((segment) => {
								segment.transitionOut = v[0];
							})
						}
						minValue={CAMERA3D_TRANSITION_LIMITS.min}
						maxValue={CAMERA3D_TRANSITION_LIMITS.max}
						step={CAMERA3D_TRANSITION_LIMITS.step}
					/>
				</Field>
				{poseSlider("fov", "Lens", (value) => `${Math.round(value)}°`)}
				{poseSlider("rotateX", "Rotate X", (value) => `${Math.round(value)}°`)}
				{poseSlider("rotateY", "Rotate Y", (value) => `${Math.round(value)}°`)}
				<div class="flex justify-end pt-1">
					<EditorButton
						size="sm"
						leftIcon={<IconLucideRotateCcw />}
						onClick={resetCamera}
					>
						Reset camera
					</EditorButton>
				</div>
			</DrillSection>
		</div>
	);
}
