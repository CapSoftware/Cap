import { Collapsible } from "@kobalte/core/collapsible";
import { Popover } from "@kobalte/core/popover";
import { Toggle } from "~/components/Toggle";
import IconCapEnlarge from "~icons/cap/enlarge";
import IconCapImage from "~icons/cap/image";
import IconCapShadow from "~icons/cap/shadow";
import IconCapSquare from "~icons/cap/square";
import { RgbInput } from "../ColorPicker";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Field, Slider } from "../ui";

export function BorderPopover() {
	const { project, setProject, activePopover, setActivePopover } =
		useScreenshotEditorContext();

	return (
		<Popover
			placement="bottom-start"
			open={activePopover() === "border"}
			onOpenChange={(open) => setActivePopover(open ? "border" : null)}
		>
			<Popover.Trigger
				as={EditorButton}
				leftIcon={<IconCapSquare class="size-4" />}
				tooltipText="Border"
				kbd={["E"]}
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[280px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div class="flex flex-col gap-4">
						<div class="flex flex-row justify-between items-center">
							<span class="text-xs font-medium text-gray-11">Border</span>
							<Toggle
								checked={project.background.border?.enabled ?? false}
								onChange={(enabled) => {
									const prev = project.background.border ?? {
										enabled: false,
										width: 5.0,
										color: [0, 0, 0],
										opacity: 50.0,
									};
									setProject("background", "border", {
										...prev,
										enabled,
									});
								}}
							/>
						</div>

						<Collapsible open={project.background.border?.enabled ?? false}>
							<Collapsible.Content class="overflow-hidden opacity-0 transition-opacity animate-collapsible-up data-expanded:animate-collapsible-down data-expanded:opacity-100">
								<div class="flex flex-col gap-4">
									<Field name="Width" icon={<IconCapEnlarge class="size-4" />}>
										<Slider
											value={[project.background.border?.width ?? 5.0]}
											onChange={(v) =>
												setProject("background", "border", {
													...(project.background.border ?? {
														enabled: true,
														width: 5.0,
														color: [0, 0, 0],
														opacity: 50.0,
													}),
													width: v[0],
												})
											}
											minValue={1}
											maxValue={20}
											step={0.1}
											formatTooltip="px"
										/>
									</Field>
									<Field name="Color" icon={<IconCapImage class="size-4" />}>
										<RgbInput
											value={project.background.border?.color ?? [0, 0, 0]}
											onChange={(color) =>
												setProject("background", "border", {
													...(project.background.border ?? {
														enabled: true,
														width: 5.0,
														color: [0, 0, 0],
														opacity: 50.0,
													}),
													color,
												})
											}
										/>
									</Field>
									<Field name="Opacity" icon={<IconCapShadow class="size-4" />}>
										<Slider
											value={[project.background.border?.opacity ?? 50.0]}
											onChange={(v) =>
												setProject("background", "border", {
													...(project.background.border ?? {
														enabled: true,
														width: 5.0,
														color: [0, 0, 0],
														opacity: 50.0,
													}),
													opacity: v[0],
												})
											}
											minValue={0}
											maxValue={100}
											step={0.1}
											formatTooltip="%"
										/>
									</Field>
								</div>
							</Collapsible.Content>
						</Collapsible>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
