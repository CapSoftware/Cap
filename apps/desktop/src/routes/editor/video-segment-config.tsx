import { Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import IconLucideCrosshair from "~icons/lucide/crosshair";
import { useEditorContext } from "./context";
import { EditorButton, Field, SectionLabel, Slider } from "./ui";

export function VideoSegmentConfig(props: { index: number }) {
	const { project, setProject, projectActions } = useEditorContext();
	const segment = () => project.timeline?.videoSegments[props.index];
	return (
		<Show when={segment()}>
			{(video) => (
				<div class="flex flex-col gap-3.5 p-4">
					<div class="flex gap-2">
						<input
							aria-label="Video name"
							class="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-ed-ctl px-2 text-[13px] text-ed-text-1 caret-ed-accent outline-hidden transition-colors duration-150 placeholder:text-ed-text-3 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
							value={video().name}
							onChange={(event) =>
								setProject(
									"timeline",
									"videoSegments",
									props.index,
									"name",
									event.currentTarget.value.trim() || "Video",
								)
							}
						/>
						<Toggle
							checked={video().enabled}
							onChange={(value) =>
								setProject(
									"timeline",
									"videoSegments",
									props.index,
									"enabled",
									value,
								)
							}
						/>
					</div>
					<div class="rounded-lg bg-ed-ctl p-3 text-[12px] text-ed-text-2">
						<div class="truncate font-medium text-ed-text-1">
							{video().name}
						</div>
						<div class="mt-1 tabular-nums">
							{(video().end - video().start).toFixed(2)}s on timeline · source
							starts at {video().sourceStart.toFixed(2)}s
						</div>
					</div>
					<div class="flex flex-col gap-2.5 rounded-lg bg-ed-card-2 p-3">
						<SectionLabel name="Arrange on canvas" />
						<p class="text-[11px] leading-relaxed text-ed-text-3">
							Drag the video to move it. Pull a corner to resize, or use the
							rotation handle to turn it. Arrow keys nudge it into place.
						</p>
						<EditorButton
							class="w-full justify-center"
							leftIcon={<IconLucideCrosshair class="size-4" />}
							onClick={() =>
								setProject("timeline", "videoSegments", props.index, "center", {
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
							value={`${(video().opacity * 100).toFixed(1)}%`}
						>
							<Slider
								value={[video().opacity * 100]}
								minValue={0}
								maxValue={100}
								step={1}
								formatTooltip="%"
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"opacity",
										value[0] / 100,
									)
								}
							/>
						</Field>
						<Field inline name="Rotation" value={`${video().rotation}°`}>
							<Slider
								value={[video().rotation]}
								minValue={-180}
								maxValue={180}
								step={1}
								formatTooltip={(value) => `${value}°`}
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
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
							value={`${video().rounding.toFixed(1)}%`}
						>
							<Slider
								value={[video().rounding]}
								minValue={0}
								maxValue={100}
								step={1}
								formatTooltip="%"
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"rounding",
										value[0],
									)
								}
							/>
						</Field>
						<Field inline name="Lock aspect ratio">
							<Toggle
								checked={video().lockAspect}
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"lockAspect",
										value,
									)
								}
							/>
						</Field>
						<Field inline name="Flip horizontally">
							<Toggle
								checked={video().flipX}
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"flipX",
										value,
									)
								}
							/>
						</Field>
						<Field inline name="Flip vertically">
							<Toggle
								checked={video().flipY}
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"flipY",
										value,
									)
								}
							/>
						</Field>
						<Field inline name="Mute source audio">
							<Toggle
								checked={video().muted}
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"muted",
										value,
									)
								}
							/>
						</Field>
						<Field
							inline
							name="Source volume"
							value={`${video().volumeDb.toFixed(1)} dB`}
						>
							<Slider
								value={[video().volumeDb]}
								minValue={-60}
								maxValue={6}
								step={1}
								formatTooltip={(value) => `${value} dB`}
								onChange={(value) =>
									setProject(
										"timeline",
										"videoSegments",
										props.index,
										"volumeDb",
										value[0],
									)
								}
							/>
						</Field>
					</div>
					<EditorButton
						variant="danger"
						onClick={() =>
							projectActions.deleteOverlaySegments("video", [props.index])
						}
					>
						Delete video
					</EditorButton>
				</div>
			)}
		</Show>
	);
}
