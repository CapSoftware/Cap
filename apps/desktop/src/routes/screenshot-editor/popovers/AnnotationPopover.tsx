import { Popover } from "@kobalte/core/popover";
import { createMemo, For, Show } from "solid-js";
import { Toggle } from "~/components/Toggle";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucideTrash from "~icons/lucide/trash-2";
import { BACKGROUND_COLORS, hexToRgb, RgbInput } from "../ColorPicker";
import { type Annotation, useScreenshotEditorContext } from "../context";
import { EditorButton, Slider } from "../ui";

export function AnnotationPopover() {
	const {
		annotations,
		setAnnotations,
		selectedAnnotationId,
		setSelectedAnnotationId,
	} = useScreenshotEditorContext();

	const selectedAnnotation = createMemo(() =>
		annotations.find((a) => a.id === selectedAnnotationId()),
	);

	const updateSelected = (key: keyof Annotation, value: any) => {
		const id = selectedAnnotationId();
		if (!id) return;
		setAnnotations((a) => a.id === id, key, value);
	};

	return (
		<Popover placement="bottom-start">
			<Popover.Trigger
				as={EditorButton}
				leftIcon={<IconLucidePencil class="size-4" />}
				tooltipText="Annotation Settings"
				disabled={!selectedAnnotation()}
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[240px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div class="flex flex-col gap-4">
						<Show
							when={selectedAnnotation()}
							fallback={
								<div class="text-center text-gray-11 text-xs font-medium">
									Select an annotation to edit.
								</div>
							}
						>
							{(annotation) => (
								<div class="flex flex-col gap-4 animate-in fade-in slide-in-from-top-2">
									<div class="flex flex-col gap-2">
										<span class="text-xs font-medium text-gray-11">
											Stroke Color
										</span>
										<RgbInput
											value={
												(hexToRgb(annotation().strokeColor)?.slice(0, 3) as [
													number,
													number,
													number,
												]) || [0, 0, 0]
											}
											onChange={(rgb) =>
												updateSelected(
													"strokeColor",
													`#${rgb
														.map((c) => c.toString(16).padStart(2, "0"))
														.join("")
														.toUpperCase()}`,
												)
											}
										/>
										{/* Color Presets */}
										<div class="flex flex-wrap gap-2 mt-1">
											<For each={BACKGROUND_COLORS.slice(0, 8)}>
												{(color) => (
													<button
														type="button"
														class="size-5 rounded-full border border-gray-4 hover:scale-110 transition-transform"
														style={{ background: color }}
														onClick={() => updateSelected("strokeColor", color)}
													/>
												)}
											</For>
										</div>
									</div>

									{(annotation().type === "rectangle" ||
										annotation().type === "circle") && (
										<div class="flex flex-col gap-2">
											<div class="flex flex-row justify-between items-center">
												<span class="text-xs font-medium text-gray-11">
													Fill Color
												</span>
												<Toggle
													size="sm"
													checked={annotation().fillColor !== "transparent"}
													onChange={(checked) =>
														updateSelected(
															"fillColor",
															checked ? "#000000" : "transparent",
														)
													}
												/>
											</div>

											{annotation().fillColor !== "transparent" && (
												<>
													<RgbInput
														value={
															(hexToRgb(
																annotation().fillColor === "transparent"
																	? "#000000"
																	: annotation().fillColor,
															)?.slice(0, 3) as [number, number, number]) || [
																0, 0, 0,
															]
														}
														onChange={(rgb) =>
															updateSelected(
																"fillColor",
																`#${rgb
																	.map((c) => c.toString(16).padStart(2, "0"))
																	.join("")
																	.toUpperCase()}`,
															)
														}
													/>
													<div class="flex flex-wrap gap-2 mt-1">
														<For each={BACKGROUND_COLORS.slice(0, 8)}>
															{(color) => (
																<button
																	type="button"
																	class="size-5 rounded-full border border-gray-4 hover:scale-110 transition-transform"
																	style={{ background: color }}
																	onClick={() =>
																		updateSelected("fillColor", color)
																	}
																/>
															)}
														</For>
													</div>
												</>
											)}
										</div>
									)}

									<div class="flex flex-col gap-2">
										<span class="text-xs font-medium text-gray-11">
											Stroke Width
										</span>
										<Slider
											value={[annotation().strokeWidth]}
											onChange={([v]) => updateSelected("strokeWidth", v)}
											minValue={1}
											maxValue={20}
											step={1}
										/>
									</div>

									<div class="flex flex-col gap-2">
										<span class="text-xs font-medium text-gray-11">
											Opacity
										</span>
										<Slider
											value={[annotation().opacity * 100]}
											onChange={([v]) => updateSelected("opacity", v / 100)}
											minValue={0}
											maxValue={100}
											formatTooltip="%"
										/>
									</div>

									{annotation().type === "text" && (
										<div class="flex flex-col gap-2">
											<span class="text-xs font-medium text-gray-11">
												Font Size
											</span>
											<Slider
												value={[annotation().height || 24]} // Text uses height as font size roughly
												onChange={([v]) => updateSelected("height", v)}
												minValue={12}
												maxValue={100}
												step={1}
											/>
										</div>
									)}

									<div class="flex justify-end mt-2">
										<EditorButton
											variant="danger"
											leftIcon={<IconLucideTrash class="size-4" />}
											onClick={() => {
												setAnnotations((prev) =>
													prev.filter((a) => a.id !== selectedAnnotationId()),
												);
												setSelectedAnnotationId(null);
											}}
										>
											Delete Annotation
										</EditorButton>
									</div>
								</div>
							)}
						</Show>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
