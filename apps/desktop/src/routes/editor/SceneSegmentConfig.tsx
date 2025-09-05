import { RadioGroup as KRadioGroup } from "@kobalte/core/radio-group";
import { createSignal, For, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import type { SceneSegment, SplitViewSettings } from "~/utils/tauri";
import IconCapTrash from "~icons/iconoir/trash";
import IconLucideAlignLeft from "~icons/lucide/align-left";
import IconLucideAlignRight from "~icons/lucide/align-right";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideClipboardCopy from "~icons/lucide/clipboard-copy";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideEyeOff from "~icons/lucide/eye-off";
import IconLucideLayout from "~icons/lucide/layout";
import IconLucideMaximize from "~icons/lucide/maximize";
import IconLucideMinimize from "~icons/lucide/minimize";
import IconLucideMonitor from "~icons/lucide/monitor";
import IconLucideSettings from "~icons/lucide/settings";
import IconLucideVideo from "~icons/lucide/video";
import { useEditorContext } from "./context";
import { EditorButton, Slider } from "./ui";

function SimplePositionControl(props: {
	position: { x: number; y: number };
	onChange: (position: { x: number; y: number }) => void;
	label: string;
}) {
	const [isDragging, setIsDragging] = createSignal(false);

	return (
		<div
			class="relative aspect-[16/9] w-full rounded-lg border border-gray-3 bg-gray-2 cursor-crosshair overflow-hidden"
			onMouseDown={(e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				setIsDragging(true);

				const updatePosition = (clientX: number, clientY: number) => {
					const x = Math.max(
						0,
						Math.min(1, (clientX - rect.left) / rect.width),
					);
					const y = Math.max(
						0,
						Math.min(1, (clientY - rect.top) / rect.height),
					);
					props.onChange({ x, y });
				};

				updatePosition(e.clientX, e.clientY);

				const handleMouseMove = (moveEvent: MouseEvent) => {
					updatePosition(moveEvent.clientX, moveEvent.clientY);
				};

				const handleMouseUp = () => {
					setIsDragging(false);
					window.removeEventListener("mousemove", handleMouseMove);
					window.removeEventListener("mouseup", handleMouseUp);
				};

				window.addEventListener("mousemove", handleMouseMove);
				window.addEventListener("mouseup", handleMouseUp);
			}}
		>
			{/* Grid lines for reference */}
			<div class="absolute inset-0 pointer-events-none">
				<div class="absolute left-1/2 top-0 bottom-0 w-px bg-gray-3 opacity-30" />
				<div class="absolute top-1/2 left-0 right-0 h-px bg-gray-3 opacity-30" />
			</div>

			{/* Position indicator */}
			<div
				class="absolute w-3 h-3 rounded-full bg-blue-9 -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-transform"
				classList={{
					"scale-125": isDragging(),
				}}
				style={{
					left: `${props.position.x * 100}%`,
					top: `${props.position.y * 100}%`,
				}}
			/>
		</div>
	);
}

export function SceneSegmentConfig(props: {
	segmentIndex: number;
	segment: SceneSegment;
}) {
	const { setProject, setEditorState, projectActions, project, totalDuration } =
		useEditorContext();

	// Initialize split view settings if not present
	const splitViewSettings = (): SplitViewSettings =>
		props.segment.splitViewSettings || {
			cameraPosition: { x: 0.5, y: 0.5 },
			screenPosition: { x: 0.5, y: 0.5 },
			cameraSide: "right",
			cameraZoom: 1.0,
			screenZoom: 1.0,
			fullscreen: false,
		};

	const layoutOptions = [
		{
			value: "default",
			label: "Default",
			icon: <IconLucideMonitor class="size-4" />,
			description: "Screen with camera overlay",
		},
		{
			value: "splitView",
			label: "Split View",
			icon: <IconLucideLayout class="size-4" />,
			description: "Side-by-side layout",
		},
		{
			value: "cameraOnly",
			label: "Camera Only",
			icon: <IconLucideVideo class="size-4" />,
			description: "Full screen camera",
		},
		{
			value: "hideCamera",
			label: "Hide Camera",
			icon: <IconLucideEyeOff class="size-4" />,
			description: "Screen recording only",
		},
	];

	// Check if duplication is possible
	const canDuplicate = () => {
		const segmentDuration = props.segment.end - props.segment.start;
		const newSegmentEnd = props.segment.end + segmentDuration;

		// Check if it would exceed timeline duration
		if (newSegmentEnd > totalDuration()) {
			return false;
		}

		// Check for overlaps with other scene segments
		const wouldOverlap = project.timeline?.sceneSegments?.some((s, i) => {
			if (i === props.segmentIndex) return false;
			return props.segment.end < s.end && newSegmentEnd > s.start;
		});

		return !wouldOverlap;
	};

	return (
		<div class="space-y-4">
			<div class="flex flex-row justify-between items-center">
				<EditorButton
					onClick={() => setEditorState("timeline", "selection", null)}
					leftIcon={<IconLucideCheck />}
				>
					Done
				</EditorButton>
				<div class="flex gap-2">
					<EditorButton
						onClick={() => {
							projectActions.duplicateSceneSegment(props.segmentIndex);
						}}
						leftIcon={<IconLucideCopy />}
						disabled={!canDuplicate()}
						title={!canDuplicate() ? "Not enough space in timeline" : undefined}
					>
						Duplicate
					</EditorButton>
					<EditorButton
						variant="danger"
						onClick={() => {
							projectActions.deleteSceneSegment(props.segmentIndex);
						}}
						leftIcon={<IconCapTrash class="text-red-11" />}
						class="text-red-11"
					>
						Delete
					</EditorButton>
				</div>
			</div>

			<div class="space-y-3">
				<div class="flex items-center gap-2">
					<IconLucideLayout class="size-4 text-gray-11" />
					<span class="text-sm font-medium text-gray-12">Camera Layout</span>
				</div>

				<KRadioGroup
					value={props.segment.mode || "default"}
					onChange={(v) => {
						setProject(
							"timeline",
							"sceneSegments",
							props.segmentIndex,
							"mode",
							v as "default" | "cameraOnly" | "hideCamera" | "splitView",
						);
					}}
					class="grid grid-cols-2 gap-2"
				>
					<For each={layoutOptions}>
						{(option) => (
							<KRadioGroup.Item value={option.value} class="relative">
								<KRadioGroup.ItemInput class="peer" />
								<KRadioGroup.ItemControl class="flex flex-col gap-1 p-3 w-full rounded-lg border border-gray-3 bg-gray-1 ui-checked:bg-gray-3 ui-checked:border-blue-9 transition-all cursor-pointer hover:border-gray-5 ui-checked:shadow-sm">
									<div class="flex items-center gap-2">
										{option.icon}
										<span class="text-sm font-medium text-gray-12">
											{option.label}
										</span>
									</div>
									<span class="text-xs text-gray-10">{option.description}</span>
								</KRadioGroup.ItemControl>
							</KRadioGroup.Item>
						)}
					</For>
				</KRadioGroup>
			</div>

			<Show when={props.segment.mode === "splitView"}>
				<div class="space-y-3 pt-3 border-t border-gray-3">
					<div class="flex items-center gap-2">
						<IconLucideSettings class="size-4 text-gray-11" />
						<span class="text-sm font-medium text-gray-12">
							Split View Settings
						</span>
					</div>

					<div class="space-y-4">
						<div class="space-y-2">
							<div class="flex items-center justify-between">
								<div class="flex flex-col gap-1">
									<label class="text-xs font-medium text-gray-11">
										Fullscreen Mode
									</label>
									<span class="text-xs text-gray-10">
										Fill entire frame without padding
									</span>
								</div>
								<Toggle
									checked={splitViewSettings().fullscreen || false}
									onChange={(checked) => {
										const currentSettings = splitViewSettings();
										setProject(
											"timeline",
											"sceneSegments",
											props.segmentIndex,
											"splitViewSettings",
											{ ...currentSettings, fullscreen: checked },
										);
									}}
								/>
							</div>
						</div>

						<div class="space-y-2">
							<label class="text-xs font-medium text-gray-11">
								Camera Side
							</label>
							<KRadioGroup
								value={splitViewSettings().cameraSide}
								onChange={(value) => {
									const currentSettings = splitViewSettings();
									setProject(
										"timeline",
										"sceneSegments",
										props.segmentIndex,
										"splitViewSettings",
										{
											...currentSettings,
											cameraSide: value as "left" | "right",
										},
									);
								}}
								class="grid grid-cols-2 gap-2"
							>
								<KRadioGroup.Item value="left" class="relative">
									<KRadioGroup.ItemInput class="peer" />
									<KRadioGroup.ItemControl class="flex items-center justify-center gap-2 px-3 py-2 w-full text-sm rounded-lg border border-gray-3 bg-gray-1 ui-checked:bg-gray-3 ui-checked:border-blue-9 transition-colors cursor-pointer">
										<IconLucideAlignLeft class="size-3.5" />
										Left
									</KRadioGroup.ItemControl>
								</KRadioGroup.Item>
								<KRadioGroup.Item value="right" class="relative">
									<KRadioGroup.ItemInput class="peer" />
									<KRadioGroup.ItemControl class="flex items-center justify-center gap-2 px-3 py-2 w-full text-sm rounded-lg border border-gray-3 bg-gray-1 ui-checked:bg-gray-3 ui-checked:border-blue-9 transition-colors cursor-pointer">
										<IconLucideAlignRight class="size-3.5" />
										Right
									</KRadioGroup.ItemControl>
								</KRadioGroup.Item>
							</KRadioGroup>
						</div>

						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-3">
								<div class="space-y-2">
									<label class="text-xs font-medium text-gray-11">
										Camera Position
									</label>
									<SimplePositionControl
										position={splitViewSettings().cameraPosition}
										onChange={(pos) => {
											const currentSettings = splitViewSettings();
											setProject(
												"timeline",
												"sceneSegments",
												props.segmentIndex,
												"splitViewSettings",
												{ ...currentSettings, cameraPosition: pos },
											);
										}}
										label="Camera"
									/>
								</div>
								<div class="space-y-2">
									<div class="flex justify-between items-center">
										<label class="text-xs font-medium text-gray-11">
											Camera Zoom
										</label>
										<span class="text-xs text-gray-10">
											{((splitViewSettings().cameraZoom || 1) * 100).toFixed(0)}
											%
										</span>
									</div>
									<Slider
										value={[splitViewSettings().cameraZoom || 1.0]}
										minValue={1.0}
										maxValue={3.0}
										step={0.1}
										onChange={([value]) => {
											const currentSettings = splitViewSettings();
											setProject(
												"timeline",
												"sceneSegments",
												props.segmentIndex,
												"splitViewSettings",
												{ ...currentSettings, cameraZoom: value },
											);
										}}
									/>
								</div>
							</div>

							<div class="space-y-3">
								<div class="space-y-2">
									<label class="text-xs font-medium text-gray-11">
										Screen Position
									</label>
									<SimplePositionControl
										position={splitViewSettings().screenPosition}
										onChange={(pos) => {
											const currentSettings = splitViewSettings();
											setProject(
												"timeline",
												"sceneSegments",
												props.segmentIndex,
												"splitViewSettings",
												{ ...currentSettings, screenPosition: pos },
											);
										}}
										label="Screen"
									/>
								</div>
								<div class="space-y-2">
									<div class="flex justify-between items-center">
										<label class="text-xs font-medium text-gray-11">
											Screen Zoom
										</label>
										<span class="text-xs text-gray-10">
											{((splitViewSettings().screenZoom || 1) * 100).toFixed(0)}
											%
										</span>
									</div>
									<Slider
										value={[splitViewSettings().screenZoom || 1.0]}
										minValue={1.0}
										maxValue={3.0}
										step={0.1}
										onChange={([value]) => {
											const currentSettings = splitViewSettings();
											setProject(
												"timeline",
												"sceneSegments",
												props.segmentIndex,
												"splitViewSettings",
												{ ...currentSettings, screenZoom: value },
											);
										}}
									/>
								</div>
							</div>
						</div>
					</div>
				</div>
			</Show>

			<Show
				when={project.timeline?.sceneSegments?.some(
					(s, i) => i !== props.segmentIndex && s.mode === props.segment.mode,
				)}
			>
				<div class="pt-3 border-t border-gray-3">
					<EditorButton
						onClick={() => {
							projectActions.copySceneSettingsFromOriginal(props.segmentIndex);
						}}
						leftIcon={<IconLucideClipboardCopy />}
						class="w-full"
					>
						Copy Settings from Original
					</EditorButton>
				</div>
			</Show>
		</div>
	);
}
