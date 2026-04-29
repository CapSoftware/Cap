import { Popover } from "@kobalte/core/popover";
import { batch } from "solid-js";
import IconCapShadow from "~icons/cap/shadow";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Slider } from "../ui";
import ShadowSettings from "./ShadowSettings";

export function ShadowPopover() {
	const { project, setProject, activePopover, setActivePopover } =
		useScreenshotEditorContext();
	let optionalScrollContainerRef: HTMLDivElement | undefined;

	return (
		<Popover
			placement="bottom-start"
			open={activePopover() === "shadow"}
			onOpenChange={(open) => {
				if (!open && activePopover() === "shadow") setActivePopover(null);
			}}
		>
			<Popover.Anchor
				as={EditorButton}
				onClick={() =>
					setActivePopover(activePopover() === "shadow" ? null : "shadow")
				}
				leftIcon={<IconCapShadow class="size-4" />}
				tooltipText="Shadow"
				kbd={["H"]}
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[280px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div ref={optionalScrollContainerRef} class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							<span class="text-xs font-medium text-gray-11">Shadow</span>
							<Slider
								value={[project.background.shadow ?? 0]}
								onChange={(v) => {
									batch(() => {
										setProject("background", "shadow", v[0]);
										if (v[0] > 0 && !project.background.advancedShadow) {
											setProject("background", "advancedShadow", {
												size: 50,
												opacity: 18,
												blur: 50,
											});
										}
									});
								}}
								minValue={0}
								maxValue={100}
								step={1}
								formatTooltip="%"
							/>
						</div>

						<ShadowSettings
							scrollRef={optionalScrollContainerRef}
							size={{
								value: [project.background.advancedShadow?.size ?? 50],
								onChange: (v) => {
									setProject("background", "advancedShadow", {
										...(project.background.advancedShadow ?? {
											size: 50,
											opacity: 18,
											blur: 50,
										}),
										size: v[0],
									});
								},
							}}
							opacity={{
								value: [project.background.advancedShadow?.opacity ?? 18],
								onChange: (v) => {
									setProject("background", "advancedShadow", {
										...(project.background.advancedShadow ?? {
											size: 50,
											opacity: 18,
											blur: 50,
										}),
										opacity: v[0],
									});
								},
							}}
							blur={{
								value: [project.background.advancedShadow?.blur ?? 50],
								onChange: (v) => {
									setProject("background", "advancedShadow", {
										...(project.background.advancedShadow ?? {
											size: 50,
											opacity: 18,
											blur: 50,
										}),
										blur: v[0],
									});
								},
							}}
						/>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
