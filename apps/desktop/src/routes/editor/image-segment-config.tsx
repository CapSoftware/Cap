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
							aria-label="图片名称"
							class="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-ed-ctl px-2 text-[13px] text-ed-text-1 caret-ed-accent outline-hidden transition-colors duration-150 placeholder:text-ed-text-3 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
							value={image().name}
							onChange={(event) =>
								setProject(
									"timeline",
									"imageSegments",
									props.index,
									"name",
									event.currentTarget.value.trim() || "图片",
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
								图片不可用。请替换以恢复此图层。
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
							{editorState.importingImage ? "导入中…" : "替换图片"}
						</EditorButton>
						<EditorButton
							variant="danger"
							onClick={() =>
								projectActions.deleteOverlaySegments("image", [props.index])
							}
						>
							删除
						</EditorButton>
					</div>
					<div class="flex flex-col gap-2.5 rounded-lg bg-ed-card-2 p-3">
						<SectionLabel name="在画布上排列" />
						<p class="text-[11px] leading-relaxed text-ed-text-3">
							拖动图片可移动。拉角可缩放，用旋转手柄可转动。方向键可微调位置。
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
							在画布上居中
						</EditorButton>
					</div>
					<div class="flex flex-col">
						<Field
							inline
							name="不透明度"
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
						<Field inline name="旋转" value={`${image().rotation}°`}>
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
							name="圆角"
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
						<Field inline name="锁定宽高比">
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
						<Field inline name="水平翻转">
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
						<Field inline name="垂直翻转">
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
						居中并重置旋转
					</EditorButton>
					<p class="text-[11px] leading-relaxed text-ed-text-3">
						拖动图片可移动。拖角可缩放。按住 Shift 可临时关闭吸附。
					</p>
				</div>
			)}
		</Show>
	);
}
