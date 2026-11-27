import { Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import { useEditorContext } from "./context";
import type { StyleGroup } from "./style";
import { EditorButton, Field, Section, Slider } from "./ui";

export function StyleGroupToggle(props: { group: StyleGroup }) {
	const { selectedStyle, toggleStyleGroup } = useEditorContext();
	return (
		<Show when={selectedStyle()}>
			{(style) => (
				<Field
					name={`Customize ${props.group}`}
					value={
						<Toggle
							checked={style().overrides[props.group] != null}
							onChange={(value) => toggleStyleGroup(props.group, value)}
						/>
					}
				>
					<p class="text-[11px] leading-relaxed text-ed-text-3">
						{style().overrides[props.group] == null
							? "Uses the styles underneath, then your global settings. Turn on to customize."
							: "Changes apply only during this style. Turn off to use the styles underneath."}
					</p>
				</Field>
			)}
		</Show>
	);
}

export function StyleSegmentConfig() {
	const {
		selectedStyle,
		editorState,
		setEditorState,
		setProject,
		exitStyleScope,
		projectActions,
	} = useEditorContext();
	const index = () => editorState.styleEditIndex;
	return (
		<Show when={selectedStyle()}>
			{(style) => (
				<div
					class="shrink-0 border-b border-purple-7/40 bg-purple-3/40 p-3"
					data-style-scope
				>
					<Section
						name={`Editing style · ${style().start.toFixed(2)}–${style().end.toFixed(2)}s`}
						action={
							<EditorButton size="sm" onClick={exitStyleScope}>
								Global settings
							</EditorButton>
						}
					>
						<div class="flex flex-col gap-3">
							<div class="flex items-center gap-2">
								<input
									aria-label="Style name"
									class="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-ed-ctl px-2 text-[13px] text-ed-text-1 caret-ed-accent outline-hidden transition-colors duration-150 placeholder:text-ed-text-3 hover:bg-ed-ctl-hover focus:bg-ed-ctl-hover focus:ring-1 focus:ring-ed-accent"
									value={style().name}
									onChange={(event) => {
										const i = index();
										if (i !== null)
											setProject(
												"timeline",
												"styleSegments",
												i,
												"name",
												event.currentTarget.value.trim() || "Style",
											);
									}}
								/>
								<Toggle
									checked={style().enabled}
									onChange={(value) => {
										const i = index();
										if (i !== null)
											setProject(
												"timeline",
												"styleSegments",
												i,
												"enabled",
												value,
											);
									}}
								/>
							</div>
							<Field
								name="Override camera-only padding"
								value={
									<Toggle
										checked={style().overrides.cameraOnlyPadding != null}
										onChange={(enabled) => {
											const i = index();
											if (i !== null)
												setProject(
													"timeline",
													"styleSegments",
													i,
													"overrides",
													"cameraOnlyPadding",
													enabled ? 10 : null,
												);
										}}
									/>
								}
							>
								<p class="text-[11px] leading-relaxed text-ed-text-3">
									Use a Camera Only scene. Padding reveals the background around
									the camera.
								</p>
								<Show when={style().overrides.cameraOnlyPadding != null}>
									<Slider
										value={[style().overrides.cameraOnlyPadding ?? 0]}
										minValue={0}
										maxValue={40}
										step={0.1}
										formatTooltip="%"
										onChange={(value) => {
											const i = index();
											if (i !== null)
												setProject(
													"timeline",
													"styleSegments",
													i,
													"overrides",
													"cameraOnlyPadding",
													Math.min(40, Math.max(0, value[0])),
												);
										}}
									/>
								</Show>
							</Field>
							<div class="flex items-center justify-between">
								<EditorButton
									onClick={() => {
										setEditorState("playbackTime", style().start);
										setEditorState("previewTime", null);
									}}
								>
									View style
								</EditorButton>
								<EditorButton
									variant="danger"
									onClick={() => {
										const i = index();
										if (i !== null)
											projectActions.deleteOverlaySegments("style", [i]);
									}}
								>
									Delete style
								</EditorButton>
							</div>
							<p class="text-[11px] leading-relaxed text-ed-text-3">
								Styles higher in the timeline take priority. Drag a track handle
								to change the order. Settings you leave unchanged come from the
								styles underneath.
							</p>
						</div>
					</Section>
				</div>
			)}
		</Show>
	);
}
