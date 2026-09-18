import { convertFileSrc } from "@tauri-apps/api/core";
import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import { commands } from "~/utils/tauri";
import IconCapCorners from "~icons/cap/corners";
import IconCapCrop from "~icons/cap/crop";
import IconCapImage from "~icons/cap/image";
import IconCapLayout from "~icons/cap/layout";
import IconCapPadding from "~icons/cap/padding";
import IconCapShadow from "~icons/cap/shadow";
import IconCapSquare from "~icons/cap/square";
import IconLucideArrowUpRight from "~icons/lucide/arrow-up-right";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideCircle from "~icons/lucide/circle";
import IconLucideCrosshair from "~icons/lucide/crosshair";
import IconLucideEyeOff from "~icons/lucide/eye-off";
import IconLucideMousePointer2 from "~icons/lucide/mouse-pointer-2";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucideSquare from "~icons/lucide/square";
import IconLucideType from "~icons/lucide/type";
import type { ScreenshotSidebarAction } from "../screenshot-editor/screenshot-sidebar";
import { useEditorContext } from "./context";
import { imageAssetPath } from "./images";
import { EditorButton, Field, SectionLabel, Slider } from "./ui";

export function ImageSegmentConfig(props: {
	index: number;
	dedicated?: boolean;
}) {
	const {
		project,
		setProject,
		editorInstance,
		projectActions,
		editorState,
		setEditorState,
		flushProjectConfig,
		requestHandoffPlayback,
	} = useEditorContext();
	const segment = () => project.timeline?.imageSegments[props.index];
	const path = () => imageAssetPath(editorInstance.path, segment()?.path ?? "");
	const [failed, setFailed] = createSignal(false);
	const [layoutOpen, setLayoutOpen] = createSignal(false);
	const openScreenshot = async (action: ScreenshotSidebarAction) => {
		try {
			const pending = requestHandoffPlayback(false);
			if (pending && !(await pending)) return;
			if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			await flushProjectConfig();
			setEditorState("timeline", "selection", null);
			window.dispatchEvent(
				new CustomEvent("cap-edit-image", {
					detail: { index: props.index, action },
				}),
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	const tools: Array<{
		label: string;
		icon: JSX.Element;
		action: ScreenshotSidebarAction;
	}> = [
		{
			label: "Select",
			icon: <IconLucideMousePointer2 />,
			action: { type: "tool", tool: "select" },
		},
		{
			label: "Draw",
			icon: <IconLucidePencil />,
			action: { type: "tool", tool: "draw" },
		},
		{
			label: "Arrow",
			icon: <IconLucideArrowUpRight />,
			action: { type: "tool", tool: "arrow" },
		},
		{
			label: "Rectangle",
			icon: <IconLucideSquare />,
			action: { type: "tool", tool: "rectangle" },
		},
		{
			label: "Mask",
			icon: <IconLucideEyeOff />,
			action: { type: "tool", tool: "mask" },
		},
		{
			label: "Circle",
			icon: <IconLucideCircle />,
			action: { type: "tool", tool: "circle" },
		},
		{
			label: "Text",
			icon: <IconLucideType />,
			action: { type: "tool", tool: "text" },
		},
	];
	const appearance: Array<{
		label: string;
		icon: JSX.Element;
		action: ScreenshotSidebarAction;
	}> = [
		{
			label: "Aspect",
			icon: <IconCapLayout />,
			action: { type: "appearance", panel: "aspect" },
		},
		{
			label: "Crop",
			icon: <IconCapCrop />,
			action: { type: "appearance", panel: "crop" },
		},
		{
			label: "Background",
			icon: <IconCapImage />,
			action: { type: "appearance", panel: "background" },
		},
		{
			label: "Padding",
			icon: <IconCapPadding />,
			action: { type: "appearance", panel: "padding" },
		},
		{
			label: "Corners",
			icon: <IconCapCorners />,
			action: { type: "appearance", panel: "rounding" },
		},
		{
			label: "Shadow",
			icon: <IconCapShadow />,
			action: { type: "appearance", panel: "shadow" },
		},
		{
			label: "Border",
			icon: <IconCapSquare />,
			action: { type: "appearance", panel: "border" },
		},
	];
	createEffect(() => {
		path();
		setFailed(false);
	});
	return (
		<Show when={segment()}>
			{(image) => (
				<div class={`flex flex-col gap-5 ${props.dedicated ? "p-4" : ""}`}>
					<div class="rounded-xl border border-ed-line bg-ed-card-2 p-2">
						<Show
							when={path() && !failed()}
							fallback={
								<p
									role="status"
									class="rounded-lg bg-orange-3 p-3 text-[13px] text-ed-text-1"
								>
									Image unavailable. Replace it to restore this layer.
								</p>
							}
						>
							<img
								src={convertFileSrc(path() ?? "")}
								alt={image().name}
								class="h-32 w-full rounded-lg object-contain"
								onError={() => setFailed(true)}
							/>
						</Show>
					</div>
					<div class="flex items-center justify-between gap-3">
						<div class="min-w-0">
							<h2 class="truncate text-sm font-semibold text-ed-text-1">
								{image().name}
							</h2>
							<p class="mt-0.5 text-[11px] text-ed-text-3">Image track</p>
						</div>
						<EditorButton
							class="shrink-0"
							leftIcon={<IconLucidePencil class="size-4" />}
							onClick={() =>
								void openScreenshot({ type: "tool", tool: "select" })
							}
						>
							Open canvas
						</EditorButton>
					</div>
					<section class="flex flex-col gap-2.5">
						<SectionLabel name="Annotate" />
						<div class="grid grid-cols-4 gap-2">
							<For each={tools}>
								{(option) => (
									<ScreenshotActionButton
										label={option.label}
										icon={option.icon}
										onClick={() => void openScreenshot(option.action)}
									/>
								)}
							</For>
						</div>
					</section>
					<section class="flex flex-col gap-2.5">
						<SectionLabel name="Appearance" />
						<div class="grid grid-cols-4 gap-2">
							<For each={appearance}>
								{(option) => (
									<ScreenshotActionButton
										label={option.label}
										icon={option.icon}
										onClick={() => void openScreenshot(option.action)}
									/>
								)}
							</For>
						</div>
					</section>
					<button
						type="button"
						aria-expanded={layoutOpen()}
						class="flex w-full items-center justify-between border-t border-ed-line pt-4 text-left text-xs font-medium text-ed-text-2 hover:text-ed-text-1"
						onClick={() => setLayoutOpen(!layoutOpen())}
					>
						Layer settings
						<IconLucideChevronDown
							class={`size-4 transition-transform ${layoutOpen() ? "rotate-180" : ""}`}
						/>
					</button>
					<Show when={layoutOpen()}>
						<div class="flex flex-col gap-3">
							<div class="flex items-center gap-2">
								<input
									aria-label="Image name"
									class="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-ed-ctl px-2 text-[13px] text-ed-text-1 caret-ed-accent outline-hidden transition-colors duration-150 placeholder:text-ed-text-3 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
									value={image().name}
									onChange={(event) =>
										setProject(
											"timeline",
											"imageSegments",
											props.index,
											"name",
											event.currentTarget.value.trim() || "Image",
										)
									}
								/>
								<Toggle
									checked={image().enabled}
									onChange={(value) =>
										setProject(
											"timeline",
											"imageSegments",
											props.index,
											"enabled",
											value,
										)
									}
								/>
							</div>
							<div class="flex justify-between gap-2">
								<EditorButton
									disabled={editorState.importingImage}
									onClick={() =>
										void projectActions.importImageSegment(
											image().track,
											image().start,
											props.index,
										)
									}
								>
									{editorState.importingImage ? "Importing…" : "Replace image"}
								</EditorButton>
								<EditorButton
									variant="danger"
									onClick={() =>
										projectActions.deleteOverlaySegments("image", [props.index])
									}
								>
									Delete
								</EditorButton>
							</div>
							<div class="flex flex-col gap-2.5 rounded-lg bg-ed-card-2 p-3">
								<p class="text-[11px] leading-relaxed text-ed-text-3">
									Drag the image to move it. Pull a corner to resize, or use the
									rotation handle to turn it. Arrow keys nudge it into place.
								</p>
								<EditorButton
									class="w-full justify-center"
									leftIcon={<IconLucideCrosshair class="size-4" />}
									onClick={() =>
										setProject(
											"timeline",
											"imageSegments",
											props.index,
											"center",
											{
												x: 0.5,
												y: 0.5,
											},
										)
									}
								>
									Center on canvas
								</EditorButton>
							</div>
							<div class="flex flex-col">
								<Field
									inline
									name="Opacity"
									value={`${(image().opacity * 100).toFixed(1)}%`}
								>
									<Slider
										value={[image().opacity * 100]}
										minValue={0}
										maxValue={100}
										step={1}
										formatTooltip="%"
										onChange={(value) =>
											setProject(
												"timeline",
												"imageSegments",
												props.index,
												"opacity",
												value[0] / 100,
											)
										}
									/>
								</Field>
								<Field inline name="Rotation" value={`${image().rotation}°`}>
									<Slider
										value={[image().rotation]}
										minValue={-180}
										maxValue={180}
										step={1}
										formatTooltip={(value) => `${value}°`}
										onChange={(value) =>
											setProject(
												"timeline",
												"imageSegments",
												props.index,
												"rotation",
												value[0],
											)
										}
									/>
								</Field>
								<Field
									inline
									name="Rounded corners"
									value={`${image().rounding.toFixed(1)}%`}
								>
									<Slider
										value={[image().rounding]}
										minValue={0}
										maxValue={100}
										step={1}
										formatTooltip="%"
										onChange={(value) =>
											setProject(
												"timeline",
												"imageSegments",
												props.index,
												"rounding",
												value[0],
											)
										}
									/>
								</Field>
								<Field inline name="Lock aspect ratio">
									<Toggle
										checked={image().lockAspect}
										onChange={(value) =>
											setProject(
												"timeline",
												"imageSegments",
												props.index,
												"lockAspect",
												value,
											)
										}
									/>
								</Field>
								<Field inline name="Flip horizontally">
									<Toggle
										checked={image().flipX}
										onChange={(value) =>
											setProject(
												"timeline",
												"imageSegments",
												props.index,
												"flipX",
												value,
											)
										}
									/>
								</Field>
								<Field inline name="Flip vertically">
									<Toggle
										checked={image().flipY}
										onChange={(value) =>
											setProject(
												"timeline",
												"imageSegments",
												props.index,
												"flipY",
												value,
											)
										}
									/>
								</Field>
							</div>
							<EditorButton
								onClick={() =>
									setProject("timeline", "imageSegments", props.index, {
										center: { x: 0.5, y: 0.5 },
										rotation: 0,
										flipX: false,
										flipY: false,
									})
								}
							>
								Center and reset rotation
							</EditorButton>
							<p class="text-[11px] leading-relaxed text-ed-text-3">
								Drag the image to move it. Drag a corner to resize. Shift
								temporarily disables snapping.
							</p>
						</div>
					</Show>
				</div>
			)}
		</Show>
	);
}

function ScreenshotActionButton(props: {
	label: string;
	icon: JSX.Element;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={`Edit image: ${props.label}`}
			class="flex h-[68px] min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-transparent bg-ed-ctl px-1 text-ed-text-2 transition-colors hover:border-ed-line hover:bg-ed-ctl-hover hover:text-ed-text-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ed-accent"
			onClick={props.onClick}
		>
			<span class="flex size-5 items-center justify-center [&>svg]:size-5">
				{props.icon}
			</span>
			<span class="max-w-full truncate text-[11px] font-medium leading-tight">
				{props.label}
			</span>
		</button>
	);
}
