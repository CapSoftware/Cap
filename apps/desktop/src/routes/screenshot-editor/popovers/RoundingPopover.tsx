import { Popover } from "@kobalte/core/popover";
import IconCapCorners from "~icons/cap/corners";
import { useScreenshotEditorContext } from "../context";
import { EditorButton, Slider } from "../ui";

export function RoundingPopover() {
	const { project, setProject, activePopover, setActivePopover } =
		useScreenshotEditorContext();

	return (
		<Popover
			placement="bottom-start"
			open={activePopover() === "rounding"}
			onOpenChange={(open) => setActivePopover(open ? "rounding" : null)}
		>
			<Popover.Trigger
				as={EditorButton}
				leftIcon={<IconCapCorners class="size-4" />}
				tooltipText="Corner Rounding"
			/>
			<Popover.Portal>
				<Popover.Content class="z-50 w-[240px] overflow-hidden rounded-xl border border-gray-3 bg-gray-1 shadow-xl animate-in fade-in zoom-in-95 p-4">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium text-gray-11 inline-flex gap-2 items-center">
									<IconCapCorners class="size-4" />
									Rounding
								</span>
								<Slider
									value={[project.background.rounding]}
									onChange={(v) => setProject("background", "rounding", v[0])}
									minValue={0}
									maxValue={100}
									step={0.1}
									formatTooltip="%"
								/>
							</div>
							<div class="flex flex-col gap-2">
								<span class="text-xs font-medium text-gray-11 inline-flex gap-2 items-center">
									<IconLucideSquareRoundCorner class="size-4" />
									Rounding Smoothness
								</span>
								<Slider
									value={[project.background.roundingSmoothness ?? 0]}
									onChange={(v) =>
										setProject("background", "roundingSmoothness", v[0])
									}
									minValue={0}
									maxValue={1}
									step={0.01}
									formatTooltip={(value) => `${Math.round(value * 100)}%`}
								/>
							</div>
						</div>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}
