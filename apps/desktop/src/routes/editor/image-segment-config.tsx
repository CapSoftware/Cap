import { convertFileSrc } from "@tauri-apps/api/core";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import { useEditorContext } from "./context";
import { imageAssetPath } from "./images";
import { EditorButton, Field, Slider } from "./ui";

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
				<div class="space-y-4 p-4">
					<div class="flex gap-2">
						<input
							aria-label="Image name"
							class="min-w-0 flex-1 rounded border border-gray-5 bg-gray-2 px-2 py-1"
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
								class="rounded bg-orange-3 p-3 text-sm text-gray-12"
							>
								Image unavailable. Replace it to restore this layer.
							</p>
						}
					>
						<img
							src={convertFileSrc(path() ?? "")}
							alt={image().name}
							class="h-28 w-full rounded object-contain bg-gray-3"
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
					<Field name="Position (% of canvas)">
						<div class="grid grid-cols-2 gap-2">
							<For each={["x", "y"] as const}>
								{(axis) => (
									<label class="flex items-center gap-2 text-xs text-gray-11">
										{axis.toUpperCase()}
										<input
											type="number"
											aria-label={`Image center ${axis} (%)`}
											class="min-w-0 w-full rounded border border-gray-5 bg-gray-2 px-2 py-1"
											min={0}
											max={100}
											step={0.1}
											value={Math.round(image().center[axis] * 1000) / 10}
											onChange={(event) => {
												const value = event.currentTarget.valueAsNumber;
												if (Number.isFinite(value))
													setProject(
														"timeline",
														"imageSegments",
														props.index,
														"center",
														axis,
														Math.min(100, Math.max(0, value)) / 100,
													);
											}}
										/>
									</label>
								)}
							</For>
						</div>
					</Field>
					<Field name="Size (% of canvas)">
						<div class="grid grid-cols-2 gap-2">
							<For each={["x", "y"] as const}>
								{(axis) => (
									<label class="flex items-center gap-2 text-xs text-gray-11">
										{axis === "x" ? "W" : "H"}
										<input
											type="number"
											aria-label={`Image ${axis === "x" ? "width" : "height"} (%)`}
											class="min-w-0 w-full rounded border border-gray-5 bg-gray-2 px-2 py-1"
											min={0.1}
											max={400}
											step={0.1}
											value={Math.round(image().size[axis] * 1000) / 10}
											onChange={(event) => {
												const value = event.currentTarget.valueAsNumber;
												if (!Number.isFinite(value)) return;
												const next = Math.min(400, Math.max(0.1, value)) / 100;
												const current = image().size;
												const scale = next / Math.max(0.001, current[axis]);
												setProject(
													"timeline",
													"imageSegments",
													props.index,
													"size",
													image().lockAspect
														? { x: current.x * scale, y: current.y * scale }
														: { ...current, [axis]: next },
												);
											}}
										/>
									</label>
								)}
							</For>
						</div>
					</Field>
					<Field name="Opacity">
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
					<Field name="Rotation">
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
					<Field name="Rounded corners">
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
					<Field
						name="Lock aspect ratio"
						value={
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
						}
					/>
					<Field
						name="Flip horizontally"
						value={
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
						}
					/>
					<Field
						name="Flip vertically"
						value={
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
						}
					/>
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
					<p class="text-xs text-gray-10">
						Drag the image to move it. Drag a corner to resize. Shift
						temporarily disables snapping.
					</p>
				</div>
			)}
		</Show>
	);
}
