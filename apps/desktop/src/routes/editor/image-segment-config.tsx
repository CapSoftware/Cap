import { convertFileSrc } from "@tauri-apps/api/core";
import { createEffect, createSignal, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import IconLucideCrosshair from "~icons/lucide/crosshair";
import { useEditorContext } from "./context";
import { imageAssetPath } from "./images";
import { EditorButton, Field, SectionLabel, Slider } from "./ui";

export function ImageSegmentConfig(props: { index: number }) {
	const { project, setProject, editorInstance, projectActions, editorState } =
		useEditorContext();
	const segment = () => project.timeline?.imageSegments[props.index];
	const path = () => imageAssetPath(editorInstance.path, segment()?.path ?? "");
	const [failed, setFailed] = createSignal(false);
	createEffect(() => {
		path();
		setFailed(false);
	});
	return (
		<Show when={segment()}>
			{(image) => (
				<div class="flex flex-col gap-3.5 p-4">
					<div class="flex gap-2">
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
							class="h-28 w-full rounded-lg object-contain bg-ed-ctl"
							onError={() => setFailed(true)}
						/>
					</Show>
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
						<SectionLabel name="Arrange on canvas" />
						<p class="text-[11px] leading-relaxed text-ed-text-3">
							Drag the image to move it. Pull a corner to resize, or use the
							rotation handle to turn it. Arrow keys nudge it into place.
						</p>
						<EditorButton
							class="w-full justify-center"
							leftIcon={<IconLucideCrosshair class="size-4" />}
							onClick={() =>
								setProject("timeline", "imageSegments", props.index, "center", {
									x: 0.5,
									y: 0.5,
								})
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
			)}
		</Show>
	);
}
