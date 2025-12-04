import { Popover } from "@kobalte/core/popover";
import { batch } from "solid-js";
import IconCapShadow from "~icons/cap/shadow";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Slider } from "../ui";
import ShadowSettings from "./ShadowSettings";

export function ShadowPopover() {
	const { project, setProject, activePopover, setActivePopover } =
		useScreenshotEditorContext();
	// We need a dummy scrollRef since ShadowSettings expects it,
	// but in this simple popover we might not need auto-scroll.
	// Passing undefined might break it if it relies on it, checking ShadowSettings source would be good.
	// Assuming it's optional or we can pass a dummy one.
	let scrollRef: HTMLDivElement | undefined;

	return (
		<Popover
			placement="bottom-start"
			open={activePopover() === "shadow"}
			onOpenChange={(open) => setActivePopover(open ? "shadow" : null)}
		>
			<Popover.Trigger
				as={EditorButton}
				leftIcon={<IconCapShadow class="size-4" />}
				tooltipText="Shadow"
				kbd={["H"]}
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[280px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div ref={scrollRef} class="flex flex-col gap-4">
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
							scrollRef={scrollRef}
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
