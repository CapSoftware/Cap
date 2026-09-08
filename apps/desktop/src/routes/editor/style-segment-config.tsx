import { Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import { useEditorContext } from "./context";
import type { StyleGroup } from "./style";
import { EditorButton, Field, Slider } from "./ui";

export function StyleGroupToggle(props: { group: StyleGroup }) {
	const { selectedStyle, toggleStyleGroup } = useEditorContext();
	return (
		<Show when={selectedStyle()}>
			{(style) => (
				<Field
					name={`Override ${props.group}`}
					value={
						<Toggle
							checked={style().overrides[props.group] != null}
							onChange={(value) => toggleStyleGroup(props.group, value)}
						/>
					}
				>
					<p class="text-xs text-gray-10">
						{style().overrides[props.group] == null
							? "Inherits earlier styles, then global settings. Enable to copy global settings into this style."
							: "Changes apply to this style only. Disable to inherit earlier styles and global settings."}
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
					class="shrink-0 space-y-3 border-b border-purple-7/40 bg-purple-3/40 p-3"
					data-style-scope
				>
					<div class="flex items-center justify-between gap-2">
						<span class="text-xs font-semibold text-gray-12">
							Editing Style · {style().start.toFixed(2)}–
							{style().end.toFixed(2)}s
						</span>
						<EditorButton onClick={exitStyleScope}>
							Global settings
						</EditorButton>
					</div>
					<div class="flex items-center gap-2">
						<input
							aria-label="Style name"
							class="min-w-0 flex-1 rounded border border-gray-5 bg-gray-2 px-2 py-1 text-sm"
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
									setProject("timeline", "styleSegments", i, "enabled", value);
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
						<p class="text-xs text-gray-10">
							Use a Camera Only scene. Padding reveals the background around the
							camera.
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
					<p class="text-[11px] text-gray-10">
						Larger lane numbers take priority. Within a lane, later styles win.
						Groups without an override inherit earlier styles, then global
						settings.
					</p>
				</div>
			)}
		</Show>
	);
}
