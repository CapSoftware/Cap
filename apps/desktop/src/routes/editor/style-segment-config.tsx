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
							? "使用下层的样式，再应用你的全局设置。开启后可自定义。"
							: "更改仅在此样式中生效。关闭后将使用下层的样式。"}
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
								全局设置
							</EditorButton>
						}
					>
						<div class="flex flex-col gap-3">
							<div class="flex items-center gap-2">
								<input
									aria-label="样式名称"
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
												event.currentTarget.value.trim() || "样式",
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
								name="覆盖仅摄像头时的边距"
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
									使用「仅摄像头」场景。边距会露出摄像头周围的背景。
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
									查看样式
								</EditorButton>
								<EditorButton
									variant="danger"
									onClick={() => {
										const i = index();
										if (i !== null)
											projectActions.deleteOverlaySegments("style", [i]);
									}}
								>
									删除样式
								</EditorButton>
							</div>
							<p class="text-[11px] leading-relaxed text-ed-text-3">
								时间线中越靠上的样式优先级越高。拖动轨道手柄可调整顺序。未修改的设置将沿用下层的样式。
							</p>
						</div>
					</Section>
				</div>
			)}
		</Show>
	);
}
